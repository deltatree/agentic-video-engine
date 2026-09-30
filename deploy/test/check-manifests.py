#!/usr/bin/env python3
"""Statische Prüfung der Kubernetes-Manifeste ohne Cluster und ohne kustomize (Story 21.8).

Baut jedes Overlay mit einem kleinen Kustomize-Nachbau (resources, namespace, JSON-6902-Patches mit
Ziel nach kind und Namens-Regex, images/secretGenerator werden übergangen) und prüft:

- jede YAML-Datei ist gültig, jede Ressource hat apiVersion, kind und metadata.name;
- jedes Patch-Ziel trifft mindestens eine Ressource, jeder Patch-Pfad ist anwendbar;
- keine doppelten Ressourcen (kind/namespace/name);
- jeder PodDisruptionBudget-Selektor trifft die Pod-Labels eines Workloads;
- jede ScaledObject-Zielressource existiert;
- Single-Writer (coordinator, api) bleiben bei einer Replik mit Recreate;
- worker-gpu setzt OPENVIDEO_BROWSER_GPU=1 (ADR 0019), kein anderer Workload und nicht die ConfigMap;
- im Overlay production-ha: Studio 2 Replikate mit RollingUpdate, PDBs, DCGM-Trigger für worker-gpu.

Aufruf: python3 deploy/test/check-manifests.py   (Exit-Code 1 bei Fehlern)
Mit kubectl: zusätzlich `kubectl kustomize deploy/k8s/overlays/<name>` (siehe deploy/README.md).
"""
import copy
import os
import re
import sys

import yaml

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "k8s")
OVERLAYS = ["local", "production", "prometheus", "production-ha"]
CLUSTER_SCOPED = {"Namespace", "PriorityClass", "ClusterRole", "ClusterRoleBinding"}
errors = []


def fail(msg):
    errors.append(msg)


def load_yaml(path):
    with open(path, encoding="utf-8") as f:
        return [d for d in yaml.safe_load_all(f) if d is not None]


def pointer_parts(path):
    return [p.replace("~1", "/").replace("~0", "~") for p in path.split("/")[1:]]


def apply_op(doc, op, where):
    parts = pointer_parts(op["path"])
    parent = doc
    for key in parts[:-1]:
        if isinstance(parent, list):
            key = int(key)
            if key >= len(parent):
                raise KeyError(f"{where}: index {key} out of range in {op['path']}")
            parent = parent[key]
        else:
            if key not in parent:
                raise KeyError(f"{where}: missing {key} in {op['path']}")
            parent = parent[key]
    last = parts[-1]
    kind = op["op"]
    if isinstance(parent, list):
        if kind == "add" and last == "-":
            parent.append(copy.deepcopy(op["value"]))
        elif kind == "add":
            parent.insert(int(last), copy.deepcopy(op["value"]))
        elif kind == "replace":
            parent[int(last)] = copy.deepcopy(op["value"])
        elif kind == "remove":
            del parent[int(last)]
        else:
            raise KeyError(f"{where}: unsupported op {kind}")
    else:
        if kind == "add":
            parent[last] = copy.deepcopy(op["value"])
        elif kind == "replace":
            if last not in parent:
                raise KeyError(f"{where}: replace of missing {op['path']}")
            parent[last] = copy.deepcopy(op["value"])
        elif kind == "remove":
            del parent[last]
        else:
            raise KeyError(f"{where}: unsupported op {kind}")


def matches(target, res):
    if "kind" in target and target["kind"] != res.get("kind"):
        return False
    if "name" in target and not re.fullmatch(target["name"], res["metadata"]["name"]):
        return False
    return True


def merge(base, patch):
    """Strategic Merge (vereinfacht): Dicts rekursiv, Listen von Dicts mit "name" nach Namen, sonst ersetzen."""
    for key, value in patch.items():
        if key == "$patch":
            continue
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            merge(base[key], value)
        elif isinstance(value, list) and isinstance(base.get(key), list) and all(isinstance(v, dict) and "name" in v for v in value + base[key]):
            for item in value:
                hit = next((b for b in base[key] if b["name"] == item["name"]), None)
                if hit is None:
                    base[key].append(copy.deepcopy(item))
                else:
                    merge(hit, item)
        else:
            base[key] = copy.deepcopy(value)


def strategic(out, docs, where):
    for doc in docs:
        target = {"kind": doc["kind"], "name": re.escape(doc["metadata"]["name"])}
        hits = [d for d in out if matches(target, d)]
        if not hits:
            fail(f"{where}: strategic patch for {doc['kind']}/{doc['metadata']['name']} matches no resource")
            continue
        for d in hits:
            if doc.get("$patch") == "delete":
                out.remove(d)
            else:
                merge(d, doc)


def build(directory):
    kpath = os.path.join(directory, "kustomization.yaml")
    k = load_yaml(kpath)[0]
    out = []
    for r in k.get("resources", []):
        full = os.path.normpath(os.path.join(directory, r))
        if os.path.isdir(full):
            out.extend(build(full))
        else:
            for d in load_yaml(full):
                for field in ("apiVersion", "kind"):
                    if field not in d:
                        fail(f"{full}: resource without {field}")
                if "name" not in d.get("metadata", {}):
                    fail(f"{full}: resource without metadata.name")
                out.append(d)
    ns = k.get("namespace")
    if ns:
        for d in out:
            if d.get("kind") not in CLUSTER_SCOPED:
                d.setdefault("metadata", {})["namespace"] = ns
    for i, p in enumerate(k.get("patches", [])):
        where = f"{kpath} patch #{i + 1}"
        if "path" in p:
            strategic(out, load_yaml(os.path.join(directory, p["path"])), where)
            continue
        if "target" not in p:
            strategic(out, [d for d in yaml.safe_load_all(p["patch"]) if d is not None], where)
            continue
        target = p.get("target", {})
        hits = [d for d in out if matches(target, d)]
        if not hits:
            fail(f"{where}: target {target} matches no resource")
            continue
        ops = yaml.safe_load(p["patch"])
        for d in hits:
            for op in ops:
                try:
                    apply_op(d, op, where)
                except (KeyError, ValueError, IndexError) as e:
                    fail(str(e))
    return out


def pod_labels(res):
    return res.get("spec", {}).get("template", {}).get("metadata", {}).get("labels", {})


def container_env(res):
    """Umgebungsvariablen mit festem Wert aller Container eines Workloads."""
    out = {}
    for c in res.get("spec", {}).get("template", {}).get("spec", {}).get("containers", []):
        for e in c.get("env", []) or []:
            if "value" in e:
                out[e["name"]] = e["value"]
    return out


def check_browser_gpu(name, resources, workloads):
    """GPU-Modus des Browser-Renderers nur auf worker-gpu (ADR 0019): eigene Cache-Schlüssel, nicht bitgleich."""
    for w in workloads:
        value = container_env(w).get("OPENVIDEO_BROWSER_GPU")
        if w["metadata"]["name"] == "worker-gpu":
            if value != "1":
                fail(f"{name}: worker-gpu must set OPENVIDEO_BROWSER_GPU=1 (ADR 0019)")
        elif value not in (None, "0"):
            fail(f"{name}: {w['metadata']['name']} must not set OPENVIDEO_BROWSER_GPU (only worker-gpu renders WebGL/WebGPU on the GPU)")
    for cm in (r for r in resources if r["kind"] == "ConfigMap"):
        if "OPENVIDEO_BROWSER_GPU" in (cm.get("data") or {}):
            fail(f"{name}: ConfigMap {cm['metadata']['name']} must not set OPENVIDEO_BROWSER_GPU; set it on worker-gpu only")


def check(name, resources):
    seen = set()
    for r in resources:
        key = (r["kind"], r["metadata"].get("namespace"), r["metadata"]["name"])
        if key in seen:
            fail(f"{name}: duplicate {key}")
        seen.add(key)
    workloads = [r for r in resources if r["kind"] in ("Deployment", "StatefulSet")]
    by_name = {r["metadata"]["name"]: r for r in workloads}
    for pdb in (r for r in resources if r["kind"] == "PodDisruptionBudget"):
        sel = pdb["spec"]["selector"]["matchLabels"]
        if not any(all(pod_labels(w).get(k) == v for k, v in sel.items()) for w in workloads):
            fail(f"{name}: PDB {pdb['metadata']['name']} selects no workload")
        if ("minAvailable" in pdb["spec"]) == ("maxUnavailable" in pdb["spec"]):
            fail(f"{name}: PDB {pdb['metadata']['name']} needs exactly one of minAvailable/maxUnavailable")
    for so in (r for r in resources if r["kind"] == "ScaledObject"):
        if so["spec"]["scaleTargetRef"]["name"] not in by_name:
            fail(f"{name}: ScaledObject {so['metadata']['name']} targets a missing workload")
    check_browser_gpu(name, resources, workloads)
    for single in ("coordinator", "api"):
        w = by_name.get(single)
        if w is None:
            fail(f"{name}: {single} missing")
            continue
        if w["spec"].get("replicas", 1) != 1 or w["spec"].get("strategy", {}).get("type") != "Recreate":
            fail(f"{name}: {single} must stay a single writer (replicas 1, Recreate)")
    if name == "production-ha":
        studio = by_name["studio"]
        if studio["spec"].get("replicas") != 2 or studio["spec"]["strategy"]["type"] != "RollingUpdate":
            fail("production-ha: studio needs 2 replicas with RollingUpdate")
        pdbs = {r["metadata"]["name"] for r in resources if r["kind"] == "PodDisruptionBudget"}
        for needed in ("studio", "worker-cpu", "worker-gpu", "worker-blender"):
            if needed not in pdbs:
                fail(f"production-ha: PDB {needed} missing")
        gpu = next(r for r in resources if r["kind"] == "ScaledObject" and r["metadata"]["name"] == "worker-gpu")
        triggers = {t["name"]: t for t in gpu["spec"]["triggers"]}
        if "DCGM_FI_DEV_GPU_UTIL" not in triggers.get("gpu-utilization", {}).get("metadata", {}).get("query", ""):
            fail("production-ha: worker-gpu has no DCGM utilization trigger")
        for single in ("coordinator", "api"):
            if by_name[single]["spec"]["template"]["spec"].get("priorityClassName") != "openvideo-critical":
                fail(f"production-ha: {single} needs priorityClassName openvideo-critical")
        cpu = next(r for r in resources if r["kind"] == "ScaledObject" and r["metadata"]["name"] == "worker-cpu")
        if cpu["spec"]["minReplicaCount"] < 2:
            fail("production-ha: worker-cpu needs at least 2 replicas")


def main():
    for f in sorted(os.popen(f"find {ROOT} -name '*.yaml'").read().split()):
        try:
            load_yaml(f)
        except yaml.YAMLError as e:
            fail(f"{f}: {e}")
    for overlay in OVERLAYS:
        try:
            resources = build(os.path.join(ROOT, "overlays", overlay))
        except (OSError, yaml.YAMLError, KeyError) as e:
            fail(f"{overlay}: {e}")
            continue
        check(overlay, resources)
        print(f"{overlay}: {len(resources)} resources")
    if errors:
        print("\n".join(f"FAIL: {e}" for e in errors), file=sys.stderr)
        sys.exit(1)
    print("OK")


if __name__ == "__main__":
    main()
