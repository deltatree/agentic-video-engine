# OpenVideo – Blender-Seite des Blender-Backends.
#
# Aufruf (durch @agentic-video/renderer-blender):
#   blender -b --factory-startup -noaudio --python-exit-code 1 \
#           --python openvideo_blender.py -- job.json
#
# Die Job-Datei enthält eine Liste von Frames. Jeder Frame enthält einen oder
# mehrere Szenen-Zustände (Offset in Frames, 0 = der Frame selbst). OpenVideo
# besitzt die Zeit: Dieses Skript wertet keine eigene Animation aus, sondern
# übernimmt die fertigen Werte. Für Motion Blur setzt es Keyframes an den
# Nachbar-Subframes.
#
# Koordinaten: Die Zustände nutzen die OpenVideo-Konvention (Y oben, wie Three.js).
# Ein Wurzel-Empty dreht alles um +90° um X in die Blender-Konvention (Z oben).
#
# Nach jedem fertigen Frame schreibt das Skript "OV_FRAME_DONE <index>" auf stdout.

import json
import math
import os
import sys

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector

BASE_FRAME = 10
ROOT_NAME = 'ov_root'
# Drehung der Wurzel: OpenVideo (Y oben) → Blender (Z oben).
ROOT_Q = Euler((math.pi / 2, 0, 0)).to_quaternion()


# ---------------------------------------------------------------------------
# Hilfen
# ---------------------------------------------------------------------------

def euler_three(rotation_deg):
    """Three.js-Euler 'XYZ' (R = Rx·Ry·Rz) entspricht Blender-Modus 'ZYX'."""
    return Euler([math.radians(v) for v in rotation_deg], 'ZYX')


def local_matrix(obj_state):
    rot = euler_three(obj_state['rotation']).to_matrix().to_4x4()
    return Matrix.Translation(Vector(obj_state['position'])) @ rot @ Matrix.Diagonal(Vector(obj_state['scale'] + [1.0]))


def set_input(node, names, value):
    """Setzt den ersten vorhandenen Eingang (Namen unterscheiden sich je Blender-Version)."""
    for name in names:
        if name in node.inputs:
            node.inputs[name].default_value = value
            return
    raise KeyError('Node %s has none of the inputs %s' % (node.bl_idname, names))


# ---------------------------------------------------------------------------
# Geometrie (Three.js-Konventionen, Y oben)
# ---------------------------------------------------------------------------

def num(spec, key, fallback):
    v = spec.get(key)
    return float(v) if isinstance(v, (int, float)) else float(fallback)


def add_grid(bm, uv, pts, uvs):
    """Fügt ein Gitter aus Vierecken hinzu. pts[i][j] = Vector, uvs[i][j] = (u, v)."""
    verts = [[bm.verts.new(p) for p in row] for row in pts]
    for i in range(len(pts) - 1):
        for j in range(len(pts[i]) - 1):
            quad = [verts[i][j], verts[i][j + 1], verts[i + 1][j + 1], verts[i + 1][j]]
            face = bm.faces.new(quad)
            corners = [uvs[i][j], uvs[i][j + 1], uvs[i + 1][j + 1], uvs[i + 1][j]]
            for loop, c in zip(face.loops, corners):
                loop[uv].uv = c


def add_disc(bm, uv, radius, y, segments, up):
    if radius <= 0:
        return
    pts = []
    uvs = []
    for j in range(segments):
        t = 2 * math.pi * j / segments
        pts.append(Vector((radius * math.sin(t), y, radius * math.cos(t))))
        uvs.append((0.5 + 0.5 * math.sin(t), 0.5 + 0.5 * math.cos(t)))
    order = list(range(segments)) if up else list(reversed(range(segments)))
    face = bm.faces.new([bm.verts.new(pts[k]) for k in order])
    for loop, k in zip(face.loops, order):
        loop[uv].uv = uvs[k]


def revolve(profile, segments):
    """Rotiert ein Profil [(radius, y)] um die Y-Achse (x = r·sin θ, z = r·cos θ wie Three.js)."""
    pts = []
    uvs = []
    n = len(profile)
    for i, (r, y) in enumerate(profile):
        row = []
        uv_row = []
        for j in range(segments + 1):
            t = 2 * math.pi * j / segments
            row.append(Vector((r * math.sin(t), y, r * math.cos(t))))
            uv_row.append((j / segments, 1 - i / (n - 1)))
        pts.append(row)
        uvs.append(uv_row)
    return pts, uvs


def torus_grid(radius, tube, radial, tubular):
    pts = []
    uvs = []
    for j in range(radial + 1):
        v = 2 * math.pi * j / radial
        row = []
        uv_row = []
        for i in range(tubular + 1):
            u = 2 * math.pi * i / tubular
            row.append(Vector(((radius + tube * math.cos(v)) * math.cos(u), (radius + tube * math.cos(v)) * math.sin(u), tube * math.sin(v))))
            uv_row.append((i / tubular, j / radial))
        pts.append(row)
        uvs.append(uv_row)
    return pts, uvs


def knot_point(u, p, q, radius):
    qu = q / p * u
    cs = math.cos(qu)
    return Vector((radius * (2 + cs) * 0.5 * math.cos(u), radius * (2 + cs) * 0.5 * math.sin(u), radius * math.sin(qu) * 0.5))


def knot_grid(radius, tube, tubular, radial, p, q):
    pts = []
    uvs = []
    for i in range(tubular + 1):
        u = i / tubular * p * 2 * math.pi
        p1 = knot_point(u, p, q, radius)
        p2 = knot_point(u + 0.01, p, q, radius)
        t = p2 - p1
        n = p2 + p1
        b = t.cross(n)
        n = b.cross(t)
        b.normalize()
        n.normalize()
        row = []
        uv_row = []
        for j in range(radial + 1):
            v = j / radial * 2 * math.pi
            cx = -tube * math.cos(v)
            cy = tube * math.sin(v)
            row.append(p1 + cx * n + cy * b)
            uv_row.append((i / tubular, j / radial))
        pts.append(row)
        uvs.append(uv_row)
    return pts, uvs


def build_mesh(name, spec):
    """Baut Mesh-Daten aus einer OpenVideo-Geometry-Beschreibung (Standardmaße wie Three.js)."""
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new('UVMap')
    kind = spec.get('type', 'box')
    segments = max(3, int(num(spec, 'segments', 32)))
    closed = True
    if kind == 'plane':
        w = num(spec, 'width', 1) / 2
        h = num(spec, 'height', 1) / 2
        add_grid(bm, uv, [[Vector((-w, -h, 0)), Vector((w, -h, 0))], [Vector((-w, h, 0)), Vector((w, h, 0))]], [[(0, 0), (1, 0)], [(0, 1), (1, 1)]])
        closed = False
    elif kind == 'sphere':
        r = num(spec, 'radius', 1)
        rows = max(2, segments // 2)
        profile = [(r * math.sin(math.pi * k / rows), r * math.cos(math.pi * k / rows)) for k in range(rows + 1)]
        pts, uvs = revolve(profile, segments)
        add_grid(bm, uv, pts, uvs)
    elif kind in ('cylinder', 'cone'):
        h = num(spec, 'height', 1)
        if kind == 'cone':
            top, bottom = 0.0, num(spec, 'radius', 1)
        else:
            top, bottom = num(spec, 'radiusTop', 1), num(spec, 'radiusBottom', 1)
        pts, uvs = revolve([(top, h / 2), (bottom, -h / 2)], segments)
        add_grid(bm, uv, pts, uvs)
    elif kind == 'capsule':
        r = num(spec, 'radius', 1)
        half = num(spec, 'length', 1) / 2
        cap = 8
        top = [(r * math.sin(math.pi / 2 * k / cap), half + r * math.cos(math.pi / 2 * k / cap)) for k in range(cap + 1)]
        bottom = [(r * math.cos(math.pi / 2 * k / cap), -half - r * math.sin(math.pi / 2 * k / cap)) for k in range(cap + 1)]
        pts, uvs = revolve(top + bottom, 16)
        add_grid(bm, uv, pts, uvs)
    elif kind == 'torus':
        pts, uvs = torus_grid(num(spec, 'radius', 1), num(spec, 'tube', 0.4), 16, 64)
        add_grid(bm, uv, pts, uvs)
    elif kind == 'torus-knot':
        pts, uvs = knot_grid(num(spec, 'radius', 1), num(spec, 'tube', 0.4), 128, 16, int(num(spec, 'p', 2)), int(num(spec, 'q', 3)))
        add_grid(bm, uv, pts, uvs)
    else:
        w = num(spec, 'width', 1) / 2
        h = num(spec, 'height', 1) / 2
        d = num(spec, 'depth', 1) / 2
        faces = [
            [(-w, -h, d), (w, -h, d), (w, h, d), (-w, h, d)],
            [(w, -h, -d), (-w, -h, -d), (-w, h, -d), (w, h, -d)],
            [(w, -h, d), (w, -h, -d), (w, h, -d), (w, h, d)],
            [(-w, -h, -d), (-w, -h, d), (-w, h, d), (-w, h, -d)],
            [(-w, h, d), (w, h, d), (w, h, -d), (-w, h, -d)],
            [(-w, -h, -d), (w, -h, -d), (w, -h, d), (-w, -h, d)],
        ]
        for corners in faces:
            face = bm.faces.new([bm.verts.new(c) for c in corners])
            for loop, c in zip(face.loops, [(0, 0), (1, 0), (1, 1), (0, 1)]):
                loop[uv].uv = c
    if kind not in ('box', 'plane'):
        # Naht und Pole verschmelzen; UVs bleiben als Eckdaten erhalten.
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    if kind in ('cylinder', 'cone'):
        # Deckel mit eigenen Punkten: flach schattiert.
        add_disc(bm, uv, top, h / 2, segments, True)
        add_disc(bm, uv, bottom, -h / 2, segments, False)
    if closed:
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    for poly in mesh.polygons:
        poly.use_smooth = kind not in ('box', 'plane')
    return mesh


# ---------------------------------------------------------------------------
# Materialien
# ---------------------------------------------------------------------------

def image_node(nodes, path, non_color):
    tex = nodes.new('ShaderNodeTexImage')
    tex.image = bpy.data.images.load(path, check_existing=True)
    if non_color:
        tex.image.colorspace_settings.name = 'Non-Color'
    return tex


def build_material(mat, spec):
    """Baut den Node-Baum eines Materials neu (Principled BSDF oder unbeleuchtet)."""
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    nodes.clear()
    out = nodes.new('ShaderNodeOutputMaterial')
    color = spec['color']
    alpha = spec['opacity']
    if spec['kind'] == 'basic':
        emission = nodes.new('ShaderNodeEmission')
        emission.inputs['Color'].default_value = color
        emission.inputs['Strength'].default_value = 1.0
        shader = emission.outputs[0]
        if spec.get('map'):
            tex = image_node(nodes, spec['map'], False)
            mix = nodes.new('ShaderNodeMix')
            mix.data_type = 'RGBA'
            mix.blend_type = 'MULTIPLY'
            mix.inputs['Factor'].default_value = 1.0
            links.new(tex.outputs['Color'], mix.inputs[6])
            mix.inputs[7].default_value = color
            links.new(mix.outputs[2], emission.inputs['Color'])
        if alpha < 1:
            transparent = nodes.new('ShaderNodeBsdfTransparent')
            mix_shader = nodes.new('ShaderNodeMixShader')
            mix_shader.inputs['Fac'].default_value = alpha
            links.new(transparent.outputs[0], mix_shader.inputs[1])
            links.new(shader, mix_shader.inputs[2])
            shader = mix_shader.outputs[0]
        links.new(shader, out.inputs['Surface'])
        return
    bsdf = nodes.new('ShaderNodeBsdfPrincipled')
    bsdf.inputs['Base Color'].default_value = color
    bsdf.inputs['Metallic'].default_value = spec['metalness']
    bsdf.inputs['Roughness'].default_value = spec['roughness']
    bsdf.inputs['Alpha'].default_value = alpha
    set_input(bsdf, ['Transmission Weight', 'Transmission'], spec['transmission'])
    set_input(bsdf, ['Coat Weight', 'Clearcoat'], spec['clearcoat'])
    set_input(bsdf, ['Emission Color', 'Emission'], spec['emissive'] + [1.0])
    bsdf.inputs['Emission Strength'].default_value = spec['emissiveIntensity']
    if spec.get('map'):
        tex = image_node(nodes, spec['map'], False)
        mix = nodes.new('ShaderNodeMix')
        mix.data_type = 'RGBA'
        mix.blend_type = 'MULTIPLY'
        mix.inputs['Factor'].default_value = 1.0
        links.new(tex.outputs['Color'], mix.inputs[6])
        mix.inputs[7].default_value = color
        links.new(mix.outputs[2], bsdf.inputs['Base Color'])
    if spec.get('roughnessMap'):
        tex = image_node(nodes, spec['roughnessMap'], True)
        sep = nodes.new('ShaderNodeSeparateColor')
        mul = nodes.new('ShaderNodeMath')
        mul.operation = 'MULTIPLY'
        mul.inputs[1].default_value = spec['roughness']
        links.new(tex.outputs['Color'], sep.inputs[0])
        links.new(sep.outputs[1], mul.inputs[0])
        links.new(mul.outputs[0], bsdf.inputs['Roughness'])
    if spec.get('normalMap'):
        tex = image_node(nodes, spec['normalMap'], True)
        nmap = nodes.new('ShaderNodeNormalMap')
        links.new(tex.outputs['Color'], nmap.inputs['Color'])
        links.new(nmap.outputs['Normal'], bsdf.inputs['Normal'])
    links.new(bsdf.outputs[0], out.inputs['Surface'])


def particle_mesh(name):
    """Kugel mit Durchmesser 1 (Ikosphäre, 2 Unterteilungen wie im Three.js-Renderer)."""
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=2, radius=0.5)
    mesh = bpy.data.meshes.new(name + '#particle')
    bm.to_mesh(mesh)
    bm.free()
    for poly in mesh.polygons:
        poly.use_smooth = True
    return mesh


def particle_material(name, additive):
    """Unbeleuchtetes Partikel-Material; Farbe aus der Objektfarbe. `additive`: Emission plus Durchsicht."""
    mat = bpy.data.materials.new(name + '#particles')
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    nodes.clear()
    info = nodes.new('ShaderNodeObjectInfo')
    emission = nodes.new('ShaderNodeEmission')
    emission.inputs['Strength'].default_value = 1.0
    links.new(info.outputs['Color'], emission.inputs['Color'])
    out = nodes.new('ShaderNodeOutputMaterial')
    shader = emission.outputs[0]
    if additive:
        # Additiv wie Three.js AdditiveBlending: Licht kommt hinzu, der Hintergrund bleibt sichtbar.
        transparent = nodes.new('ShaderNodeBsdfTransparent')
        add = nodes.new('ShaderNodeAddShader')
        links.new(transparent.outputs[0], add.inputs[0])
        links.new(shader, add.inputs[1])
        shader = add.outputs[0]
        if hasattr(mat, 'surface_render_method'):
            mat.surface_render_method = 'BLENDED'
        elif hasattr(mat, 'blend_method'):
            mat.blend_method = 'BLEND'
    links.new(shader, out.inputs['Surface'])
    return mat


def mask_materials():
    white = bpy.data.materials.new('ov_mask_white')
    white.use_nodes = True
    nodes = white.node_tree.nodes
    nodes.clear()
    emission = nodes.new('ShaderNodeEmission')
    emission.inputs['Color'].default_value = (1, 1, 1, 1)
    out = nodes.new('ShaderNodeOutputMaterial')
    white.node_tree.links.new(emission.outputs[0], out.inputs['Surface'])
    holdout = bpy.data.materials.new('ov_mask_holdout')
    holdout.use_nodes = True
    nodes = holdout.node_tree.nodes
    nodes.clear()
    h = nodes.new('ShaderNodeHoldout')
    out = nodes.new('ShaderNodeOutputMaterial')
    holdout.node_tree.links.new(h.outputs[0], out.inputs['Surface'])
    return white, holdout


# ---------------------------------------------------------------------------
# Modelle (glTF/GLB/OBJ) und ihre Animationen
# ---------------------------------------------------------------------------

class Model:
    """Ein importiertes Modell. Clips werden nicht abgespielt, sondern zur Zeit ausgewertet."""

    def __init__(self, key, path, fmt, parent):
        self.path = path
        before = set(bpy.data.objects)
        if fmt == 'obj':
            bpy.ops.wm.obj_import(filepath=path)
        else:
            bpy.ops.import_scene.gltf(filepath=path)
        self.objects = [o for o in bpy.data.objects if o not in before]
        # Importer liefern Z-oben; das innere Empty dreht zurück in die Y-oben-Konvention.
        self.inner = bpy.data.objects.new(key + '#inner', None)
        bpy.context.scene.collection.objects.link(self.inner)
        self.inner.parent = parent
        self.inner.rotation_euler = (-math.pi / 2, 0, 0)
        for o in self.objects:
            if o.parent is None:
                o.parent = self.inner
        self.clips = {}
        blocks = []
        for o in self.objects:
            blocks.append(o)
            if o.type == 'MESH' and o.data.shape_keys is not None:
                blocks.append(o.data.shape_keys)
        for block in blocks:
            ad = block.animation_data
            if ad is None:
                continue
            if ad.action is not None:
                self.add_clip(ad.action.name, block, ad.action)
            for track in ad.nla_tracks:
                for strip in track.strips:
                    if strip.action is not None:
                        self.add_clip(track.name, block, strip.action)
                        self.add_clip(strip.action.name, block, strip.action)
            block.animation_data_clear()
        self.override = None

    def add_clip(self, name, block, action):
        entries = self.clips.setdefault(name, [])
        if (block, action) not in entries:
            entries.append((block, action))

    def find_clip(self, name):
        if name in self.clips:
            return self.clips[name]
        for key, entries in self.clips.items():
            if key.startswith(name + '_') or key.startswith(name + '.'):
                return entries
        raise KeyError('Animation clip "%s" not found. Available: %s' % (name, ', '.join(sorted(self.clips)) or 'none'))

    def apply_clip(self, clip, fps):
        entries = self.find_clip(clip['name'])
        for block, action in entries:
            start, end = action.frame_range
            duration = (end - start) / fps
            t = clip['seconds']
            if clip['loop'] and duration > 0:
                t = t % duration
            else:
                t = min(max(t, 0.0), duration)
            frame = start + t * fps
            for fc in action.fcurves:
                owner_path, _, attr = fc.data_path.rpartition('.')
                owner = block.path_resolve(owner_path) if owner_path else block
                value = fc.evaluate(frame)
                current = getattr(owner, attr)
                if isinstance(current, (int, float, bool)):
                    setattr(owner, attr, type(current)(value))
                else:
                    current[fc.array_index] = value

    def meshes(self):
        return [o for o in self.objects if o.type == 'MESH']

    def remove(self):
        for o in self.objects:
            bpy.data.objects.remove(o, do_unlink=True)
        bpy.data.objects.remove(self.inner, do_unlink=True)


# ---------------------------------------------------------------------------
# Szene
# ---------------------------------------------------------------------------

class Runner:
    def __init__(self, job):
        self.job = job
        self.scene = bpy.context.scene
        for o in list(bpy.data.objects):
            bpy.data.objects.remove(o, do_unlink=True)
        self.root = bpy.data.objects.new(ROOT_NAME, None)
        self.scene.collection.objects.link(self.root)
        self.root.rotation_mode = 'QUATERNION'
        self.root.rotation_quaternion = ROOT_Q
        self.objects = {}
        self.kinds = {}
        self.geometry = {}
        self.material_specs = {}
        self.models = {}
        self.instances = {}
        self.particles = {}
        self.world_spec = None
        self.comp_spec = None
        self.default_camera = None
        self.mask_white, self.mask_holdout = mask_materials()
        # Import von Modellen setzt Keyframes relativ zu dieser Bildrate.
        self.scene.render.fps = 24
        self.scene.render.fps_base = 1.0
        self.import_fps = 24.0

    # -- Objekte ------------------------------------------------------------

    def ensure_object(self, s):
        key = s['key']
        kind = s['kind']
        obj = self.objects.get(key)
        if obj is not None and self.kinds[key] == kind:
            if kind == 'light' and obj.data.type != s['light']['type']:
                self.remove_object(key)
                obj = None
            else:
                return obj
        elif obj is not None:
            self.remove_object(key)
        data = None
        if kind == 'camera':
            data = bpy.data.cameras.new(key)
        elif kind == 'light':
            data = bpy.data.lights.new(key, s['light']['type'])
        elif kind == 'mesh':
            data = build_mesh(key, s['geometry'])
            self.geometry[key] = json.dumps(s['geometry'], sort_keys=True)
            data.materials.append(bpy.data.materials.new(key))
        obj = bpy.data.objects.new(key, data)
        self.scene.collection.objects.link(obj)
        self.objects[key] = obj
        self.kinds[key] = kind
        return obj

    def remove_object(self, key):
        if key in self.models:
            self.models.pop(key).remove()
        for child in self.instances.pop(key, []):
            bpy.data.objects.remove(child, do_unlink=True)
        self.remove_particles(key)
        obj = self.objects.pop(key)
        self.kinds.pop(key)
        self.geometry.pop(key, None)
        self.material_specs.pop(key, None)
        bpy.data.objects.remove(obj, do_unlink=True)

    def update_material(self, key, mat, spec):
        text = json.dumps(spec, sort_keys=True)
        if self.material_specs.get(key) != text:
            build_material(mat, spec)
            self.material_specs[key] = text

    def apply_objects(self, state):
        seen = set()
        world_matrix = {}
        for s in state['objects']:
            obj = self.ensure_object(s)
            key = s['key']
            seen.add(key)
            obj.parent = self.objects[s['parent']] if s['parent'] else self.root
            local = local_matrix(s)
            parent_world = world_matrix.get(s['parent'], Matrix.Identity(4))
            world_matrix[key] = parent_world @ local
            obj.location = s['position']
            obj.scale = s['scale']
            target = s.get('target')
            if target is not None:
                # Blickrichtung aus Weltposition und Ziel; lokal relativ zum Elternteil.
                pos = world_matrix[key].to_translation()
                direction = Vector(target) - pos
                if direction.length < 1e-9:
                    direction = Vector((0, 0, -1))
                # to_track_quat nimmt Blender-Z als oben an; daher im Blender-Raum rechnen.
                world_q = ROOT_Q.inverted() @ (ROOT_Q @ direction).to_track_quat('-Z', 'Y')
                obj.rotation_mode = 'QUATERNION'
                obj.rotation_quaternion = parent_world.to_quaternion().inverted() @ world_q
                world_matrix[key] = Matrix.Translation(pos) @ world_q.to_matrix().to_4x4() @ Matrix.Diagonal(Vector(s['scale'] + [1.0]))
            else:
                obj.rotation_mode = 'ZYX'
                obj.rotation_euler = euler_three(s['rotation'])
            kind = s['kind']
            if kind == 'camera':
                self.apply_camera(obj.data, s['camera'])
            elif kind == 'light':
                self.apply_light(obj.data, s['light'])
            elif kind == 'mesh':
                self.apply_mesh(key, obj, s)
            elif kind == 'model':
                self.apply_model(key, obj, s)
            elif kind == 'instances':
                self.apply_instances(key, obj, s)
            elif kind == 'particles':
                self.apply_particles(key, obj, s)
        for key in list(self.objects):
            if key not in seen:
                self.remove_object(key)

    def apply_camera(self, cam, c):
        cam.sensor_fit = 'VERTICAL'
        cam.clip_start = c['near']
        cam.clip_end = c['far']
        if c['projection'] == 'orthographic':
            cam.type = 'ORTHO'
            cam.ortho_scale = c['orthoHeight'] / max(c['zoom'], 1e-6)
        else:
            cam.type = 'PERSP'
            half = math.radians(c['fov']) / 2
            cam.angle_y = 2 * math.atan(math.tan(half) / max(c['zoom'], 1e-6))

    def apply_light(self, light, spec):
        light.color = spec['color']
        light.energy = spec['energy']
        if spec['type'] == 'SPOT':
            light.spot_size = min(math.pi, math.radians(spec['angle']) * 2)
            light.spot_blend = spec['penumbra']
        if spec['type'] in ('POINT', 'SPOT'):
            light.shadow_soft_size = 0.0

    def apply_mesh(self, key, obj, s):
        text = json.dumps(s['geometry'], sort_keys=True)
        if self.geometry.get(key) != text:
            old = obj.data
            mesh = build_mesh(key, s['geometry'])
            mesh.materials.append(old.materials[0])
            obj.data = mesh
            bpy.data.meshes.remove(old)
            self.geometry[key] = text
        self.update_material(key, obj.data.materials[0], s['material'])
        self.apply_wireframe(obj, s['material'])

    def apply_wireframe(self, obj, material):
        mod = obj.modifiers.get('ov_wireframe')
        if material.get('wireframe'):
            if mod is None:
                mod = obj.modifiers.new('ov_wireframe', 'WIREFRAME')
                mod.thickness = 0.02
        elif mod is not None:
            obj.modifiers.remove(mod)

    def apply_model(self, key, obj, s):
        model = self.models.get(key)
        if model is None or model.path != s['model']['path']:
            if model is not None:
                model.remove()
            model = Model(key, s['model']['path'], s['model']['format'], obj)
            self.models[key] = model
        if s['model'].get('clip'):
            model.apply_clip(s['model']['clip'], self.import_fps)
        for name, value in s['model'].get('morphTargets', {}).items():
            for o in model.meshes():
                keys = o.data.shape_keys
                if keys is not None and name in keys.key_blocks:
                    keys.key_blocks[name].value = value
        material = s['model'].get('material')
        if material is not None:
            if model.override is None:
                model.override = bpy.data.materials.new(key + '#material')
                for o in model.meshes():
                    if len(o.data.materials) == 0:
                        o.data.materials.append(model.override)
                    for i in range(len(o.data.materials)):
                        o.data.materials[i] = model.override
            self.update_material(key, model.override, material)

    def apply_instances(self, key, obj, s):
        transforms = s['instances']['transforms']
        children = self.instances.get(key, [])
        text = json.dumps(s['geometry'], sort_keys=True)
        if len(children) != len(transforms) or self.geometry.get(key) != text:
            for child in children:
                bpy.data.objects.remove(child, do_unlink=True)
            mesh = build_mesh(key, s['geometry'])
            mesh.materials.append(bpy.data.materials.new(key))
            children = []
            for i in range(len(transforms)):
                child = bpy.data.objects.new('%s#%d' % (key, i), mesh)
                self.scene.collection.objects.link(child)
                child.parent = obj
                child.rotation_mode = 'ZYX'
                children.append(child)
            self.instances[key] = children
            self.geometry[key] = text
        for child, t in zip(children, transforms):
            child.location = t['position']
            child.rotation_euler = euler_three(t['rotation'])
            child.scale = t['scale']
        if children:
            mat = children[0].data.materials[0]
            self.update_material(key, mat, s['material'])

    def apply_particles(self, key, obj, s):
        """Partikel als Instanzen: je lebendes Partikel eine Kugel (Durchmesser = size) mit eigener Farbe.

        Die Objekte sind nach Partikel-Index gepoolt; nicht lebende Partikel werden ausgeblendet.
        Die Farbe steht in der Objektfarbe (linear) und wird vom Material über Object Info gelesen.
        """
        spec = s['particles']
        pool = self.particles.get(key)
        if pool is None or pool['additive'] != spec['additive']:
            if pool is not None:
                self.remove_particles(key)
            mesh = particle_mesh(key)
            mat = particle_material(key, spec['additive'])
            mesh.materials.append(mat)
            pool = {'mesh': mesh, 'material': mat, 'additive': spec['additive'], 'objects': {}}
            self.particles[key] = pool
        alive = set()
        for p in spec['items']:
            index = p['index']
            alive.add(index)
            child = pool['objects'].get(index)
            if child is None:
                child = bpy.data.objects.new('%s#p%d' % (key, index), pool['mesh'])
                self.scene.collection.objects.link(child)
                child.parent = obj
                child.rotation_mode = 'ZYX'
                pool['objects'][index] = child
            child.location = p['position']
            child.scale = (p['size'], p['size'], p['size'])
            child.color = p['color'] + [1.0]
            child.hide_render = False
        for index, child in pool['objects'].items():
            if index not in alive:
                child.hide_render = True

    def remove_particles(self, key):
        pool = self.particles.pop(key, None)
        if pool is None:
            return
        for child in pool['objects'].values():
            bpy.data.objects.remove(child, do_unlink=True)
        bpy.data.meshes.remove(pool['mesh'])
        bpy.data.materials.remove(pool['material'])

    def children_objects(self, visible_only=True):
        """Instanzen und Partikel (für Motion-Blur-Keyframes nur sichtbare Partikel)."""
        out = []
        for children in self.instances.values():
            out.extend(children)
        for pool in self.particles.values():
            out.extend(o for o in pool['objects'].values() if not (visible_only and o.hide_render))
        return out

    # -- Welt ---------------------------------------------------------------

    def apply_world(self, w, mask_pass):
        spec = dict(w)
        spec['maskPass'] = mask_pass
        text = json.dumps(spec, sort_keys=True)
        if self.world_spec == text:
            return
        self.world_spec = text
        world = self.scene.world
        if world is None:
            world = bpy.data.worlds.new('ov_world')
            self.scene.world = world
        world.use_nodes = True
        nodes = world.node_tree.nodes
        links = world.node_tree.links
        nodes.clear()
        out = nodes.new('ShaderNodeOutputWorld')
        if mask_pass:
            bg = nodes.new('ShaderNodeBackground')
            bg.inputs['Color'].default_value = (0, 0, 0, 1)
            links.new(bg.outputs[0], out.inputs['Surface'])
            return
        # Beleuchtung: Summe aus Umgebungslicht, Halbkugel-Verlauf und HDRI/Preset.
        ambient = nodes.new('ShaderNodeRGB')
        ambient.outputs[0].default_value = w['ambient'] + [1.0]
        light_color = ambient.outputs[0]
        if w['sky'] is not None:
            coord = nodes.new('ShaderNodeTexCoord')
            sep = nodes.new('ShaderNodeSeparateXYZ')
            links.new(coord.outputs['Generated'], sep.inputs[0])
            ramp = nodes.new('ShaderNodeMapRange')
            ramp.inputs['From Min'].default_value = -1.0
            ramp.inputs['From Max'].default_value = 1.0
            links.new(sep.outputs['Z'], ramp.inputs['Value'])
            grad = nodes.new('ShaderNodeMix')
            grad.data_type = 'RGBA'
            links.new(ramp.outputs[0], grad.inputs['Factor'])
            grad.inputs[6].default_value = w['ground'] + [1.0]
            grad.inputs[7].default_value = w['sky'] + [1.0]
            add = nodes.new('ShaderNodeMix')
            add.data_type = 'RGBA'
            add.blend_type = 'ADD'
            add.inputs['Factor'].default_value = 1.0
            links.new(light_color, add.inputs[6])
            links.new(grad.outputs[2], add.inputs[7])
            light_color = add.outputs[2]
        env_color = None
        if w['hdri'] is not None:
            tex = nodes.new('ShaderNodeTexEnvironment')
            tex.image = bpy.data.images.load(w['hdri'], check_existing=True)
            scale = nodes.new('ShaderNodeMix')
            scale.data_type = 'RGBA'
            scale.blend_type = 'MULTIPLY'
            scale.inputs['Factor'].default_value = 1.0
            links.new(tex.outputs['Color'], scale.inputs[6])
            scale.inputs[7].default_value = (w['envIntensity'],) * 3 + (1.0,)
            env_color = scale.outputs[2]
            add = nodes.new('ShaderNodeMix')
            add.data_type = 'RGBA'
            add.blend_type = 'ADD'
            add.inputs['Factor'].default_value = 1.0
            links.new(light_color, add.inputs[6])
            links.new(env_color, add.inputs[7])
            light_color = add.outputs[2]
        lighting = nodes.new('ShaderNodeBackground')
        lighting.inputs['Strength'].default_value = 1.0
        links.new(light_color, lighting.inputs['Color'])
        surface = lighting.outputs[0]
        if w['background'] is not None:
            # Die Kamera sieht die Hintergrundfarbe, die Szene das Licht.
            camera_bg = nodes.new('ShaderNodeBackground')
            camera_bg.inputs['Color'].default_value = w['background'] + [1.0]
            path = nodes.new('ShaderNodeLightPath')
            mix = nodes.new('ShaderNodeMixShader')
            links.new(path.outputs['Is Camera Ray'], mix.inputs['Fac'])
            links.new(lighting.outputs[0], mix.inputs[1])
            links.new(camera_bg.outputs[0], mix.inputs[2])
            surface = mix.outputs[0]
        links.new(surface, out.inputs['Surface'])
        if w['volume'] is not None:
            vol = nodes.new('ShaderNodeVolumePrincipled')
            vol.inputs['Color'].default_value = w['volume']['color'] + [1.0]
            vol.inputs['Density'].default_value = w['volume']['density']
            vol.inputs['Anisotropy'].default_value = w['volume']['anisotropy']
            links.new(vol.outputs[0], out.inputs['Volume'])

    # -- Render-Einstellungen und Compositor --------------------------------

    def apply_render(self, st, threads):
        scene = self.scene
        render = scene.render
        render.engine = 'CYCLES' if st['engine'] == 'cycles' else 'BLENDER_EEVEE_NEXT'
        render.resolution_x = st['width']
        render.resolution_y = st['height']
        render.resolution_percentage = 100
        render.pixel_aspect_x = 1
        render.pixel_aspect_y = 1
        render.threads_mode = 'FIXED'
        render.threads = threads
        render.dither_intensity = 0.0
        render.use_compositing = True
        render.use_sequencer = False
        render.image_settings.file_format = 'PNG'
        render.image_settings.color_mode = 'RGBA'
        render.image_settings.color_depth = '8'
        render.image_settings.compression = 15
        data_pass = st['pass'] in ('depth', 'normal')
        mask_pass = st['pass'] == 'object-mask'
        render.film_transparent = mask_pass or (not data_pass and st['world']['transparent'])
        view = scene.view_settings
        scene.display_settings.display_device = 'sRGB'
        # Datenpässe (Tiefe, Normale, Maske) ohne Farbumwandlung speichern.
        view.view_transform = 'Standard' if st['pass'] == 'combined' else 'Raw'
        view.look = 'None'
        view.exposure = 0.0
        view.gamma = 1.0
        view.use_curve_mapping = False
        if st['engine'] == 'cycles':
            c = scene.cycles
            c.device = 'CPU'
            c.samples = st['samples']
            c.use_adaptive_sampling = False
            c.seed = st['seed']
            c.use_animated_seed = False
            c.use_denoising = False
            c.use_auto_tile = False
            c.tile_size = 2048
            c.pixel_filter_type = 'BLACKMAN_HARRIS'
            c.filter_width = 1.5
            c.sample_clamp_direct = 0.0
            c.sample_clamp_indirect = 10.0
        else:
            scene.eevee.taa_render_samples = st['samples']
        render.use_motion_blur = st['motionBlur'] and st['shutter'] > 0
        if render.use_motion_blur:
            render.motion_blur_shutter = st['shutter']
            if st['engine'] != 'cycles':
                scene.eevee.motion_blur_steps = 4
        layer = scene.view_layers[0]
        fog = st['world']['fog'] is not None and st['pass'] == 'combined'
        layer.use_pass_z = st['pass'] == 'depth' or fog
        layer.use_pass_normal = st['pass'] == 'normal'
        layer.use_pass_mist = fog
        if layer.use_pass_mist:
            mist = scene.world.mist_settings
            mist.start = st['world']['fog']['near']
            mist.depth = max(1e-6, st['world']['fog']['far'] - st['world']['fog']['near'])
            mist.falloff = 'LINEAR'
        self.apply_compositor(st)

    def apply_compositor(self, st):
        scene = self.scene
        fog = st['world']['fog'] if st['pass'] == 'combined' else None
        # Hintergrund: Cycles liefert Tiefe 1e10, Eevee die Fernebene der Kamera.
        background_depth = self.scene.camera.data.clip_end * 0.999
        spec = json.dumps({'pass': st['pass'], 'fog': fog, 'far': background_depth}, sort_keys=True)
        if self.comp_spec == spec:
            return
        self.comp_spec = spec
        if st['pass'] == 'combined' and fog is None:
            scene.use_nodes = False
            return
        scene.use_nodes = True
        tree = scene.node_tree
        nodes = tree.nodes
        links = tree.links
        nodes.clear()
        rl = nodes.new('CompositorNodeRLayers')
        comp = nodes.new('CompositorNodeComposite')
        comp.use_alpha = True
        if st['pass'] == 'depth':
            # Nah = 0 (schwarz), fern = 1 (weiß); der Hintergrund liegt jenseits und wird 1.
            # Normalize überspringt Werte ab 10000; Eevee-Hintergrund daher auf 1e10 heben.
            is_bg = nodes.new('CompositorNodeMath')
            is_bg.operation = 'GREATER_THAN'
            links.new(rl.outputs['Depth'], is_bg.inputs[0])
            is_bg.inputs[1].default_value = background_depth
            lift = nodes.new('CompositorNodeMath')
            lift.operation = 'MULTIPLY_ADD'
            links.new(is_bg.outputs[0], lift.inputs[0])
            lift.inputs[1].default_value = 1e10
            links.new(rl.outputs['Depth'], lift.inputs[2])
            norm = nodes.new('CompositorNodeNormalize')
            links.new(lift.outputs[0], norm.inputs[0])
            links.new(norm.outputs[0], comp.inputs['Image'])
        elif st['pass'] == 'normal':
            # Weltnormale in OpenVideo-Achsen (Y oben): (x, z, -y) · 0,5 + 0,5.
            sep = nodes.new('CompositorNodeSeparateColor')
            links.new(rl.outputs['Normal'], sep.inputs[0])
            channels = []
            for index, sign in ((0, 0.5), (2, 0.5), (1, -0.5)):
                m = nodes.new('CompositorNodeMath')
                m.operation = 'MULTIPLY_ADD'
                links.new(sep.outputs[index], m.inputs[0])
                m.inputs[1].default_value = sign
                m.inputs[2].default_value = 0.5
                channels.append(m)
            comb = nodes.new('CompositorNodeCombineColor')
            for i, m in enumerate(channels):
                links.new(m.outputs[0], comb.inputs[i])
            comb.inputs[3].default_value = 1.0
            links.new(comb.outputs[0], comp.inputs['Image'])
        elif st['pass'] == 'object-mask':
            links.new(rl.outputs['Alpha'], comp.inputs['Image'])
        else:
            # Lineares Nebelmodell wie Three.js `Fog`: Mischung mit der Nebelfarbe über den Mist-Pass.
            # Wie bei Three.js bleibt der Hintergrund (Tiefe "unendlich") ohne Nebel.
            hit = nodes.new('CompositorNodeMath')
            hit.operation = 'LESS_THAN'
            links.new(rl.outputs['Depth'], hit.inputs[0])
            hit.inputs[1].default_value = background_depth
            fac = nodes.new('CompositorNodeMath')
            fac.operation = 'MULTIPLY'
            links.new(rl.outputs['Mist'], fac.inputs[0])
            links.new(hit.outputs[0], fac.inputs[1])
            mix = nodes.new('CompositorNodeMixRGB')
            mix.blend_type = 'MIX'
            mix.use_alpha = False
            links.new(fac.outputs[0], mix.inputs['Fac'])
            links.new(rl.outputs['Image'], mix.inputs[1])
            mix.inputs[2].default_value = fog['color'] + [1.0]
            set_alpha = nodes.new('CompositorNodeSetAlpha')
            set_alpha.mode = 'REPLACE_ALPHA'
            links.new(mix.outputs[0], set_alpha.inputs['Image'])
            links.new(rl.outputs['Alpha'], set_alpha.inputs['Alpha'])
            links.new(set_alpha.outputs[0], comp.inputs['Image'])

    # -- Kamera und Maske ---------------------------------------------------

    def apply_camera_choice(self, st):
        if st['camera'] is not None:
            self.scene.camera = self.objects[st['camera']]
            return
        if self.default_camera is None:
            cam = bpy.data.objects.new('ov_default_camera', bpy.data.cameras.new('ov_default_camera'))
            self.scene.collection.objects.link(cam)
            cam.parent = self.root
            cam.location = (0, 0, 5)
            cam.data.sensor_fit = 'VERTICAL'
            cam.data.angle_y = math.radians(50)
            cam.data.clip_start = 0.1
            cam.data.clip_end = 1000
            self.default_camera = cam
        self.scene.camera = self.default_camera

    def mesh_objects_of(self, key):
        obj = self.objects[key]
        out = []
        stack = [obj]
        while stack:
            o = stack.pop()
            if o.type == 'MESH':
                out.append(o)
            stack.extend(o.children)
        return out

    def set_mask(self, mask_key):
        """Maskenpass: Maskenobjekt weiß, alle anderen Holdout (verdecken, aber zählen nicht)."""
        masked = set(self.mesh_objects_of(mask_key)) if mask_key is not None else set()
        for o in bpy.data.objects:
            if o.type != 'MESH':
                continue
            for slot in o.material_slots:
                if mask_key is None:
                    slot.link = 'DATA'
                else:
                    slot.link = 'OBJECT'
                    slot.material = self.mask_white if o in masked else self.mask_holdout

    # -- Ablauf -------------------------------------------------------------

    def keyframe_transforms(self, frame):
        for obj in list(self.objects.values()) + self.children_objects():
            obj.keyframe_insert('location', frame=frame)
            obj.keyframe_insert('scale', frame=frame)
            if obj.rotation_mode == 'QUATERNION':
                obj.keyframe_insert('rotation_quaternion', frame=frame)
            else:
                obj.keyframe_insert('rotation_euler', frame=frame)

    def render(self, frame, path):
        states = sorted(frame['states'], key=lambda s: (s['offset'] == 0, s['offset']))
        main = states[-1]['scene']
        for obj in list(self.objects.values()) + self.children_objects(visible_only=False):
            obj.animation_data_clear()
        blur = main['motionBlur'] and len(states) > 1
        for s in states:
            self.apply_objects(s['scene'])
            if blur:
                self.keyframe_transforms(BASE_FRAME + s['offset'])
        if blur:
            for obj in list(self.objects.values()) + self.children_objects():
                if obj.animation_data is not None and obj.animation_data.action is not None:
                    for fc in obj.animation_data.action.fcurves:
                        for kp in fc.keyframe_points:
                            kp.interpolation = 'LINEAR'
        offsets = [s['offset'] for s in states]
        main = dict(main)
        main['shutter'] = (max(offsets) - min(offsets)) if blur else 0.0
        mask_pass = main['pass'] == 'object-mask'
        self.apply_world(main['world'], mask_pass)
        self.apply_camera_choice(main)
        self.apply_render(main, self.job['threads'])
        self.set_mask(main['mask'] if mask_pass else None)
        self.scene.frame_set(BASE_FRAME)
        self.scene.render.filepath = path
        bpy.ops.render.render(write_still=True)


def main():
    argv = sys.argv[sys.argv.index('--') + 1:]
    with open(argv[0], 'r', encoding='utf-8') as f:
        job = json.load(f)
    runner = Runner(job)
    for index, frame in enumerate(job['frames']):
        runner.render(frame, os.path.join(job['outDir'], 'frame_%05d.png' % index))
        print('OV_FRAME_DONE %d' % index, flush=True)


main()
