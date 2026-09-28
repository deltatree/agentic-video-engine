/**
 * Dienste, die Agent-Operationen nutzen. Die konkrete Verdrahtung (Renderer, Compiler,
 * Assets, Scheduler) übergibt der Host (CLI, Server) beim Start.
 */
import type { Diagnostic, Patch, RgbaImage } from '@agentic-video/core';
import type { ChunkRunner, RenderEnvironment } from '@agentic-video/render';
import type { Telemetry } from '@agentic-video/telemetry';
import type { JobManager } from './jobs.js';
import type { Workspace } from './workspace.js';

/** Ein Template (lesbarer Quellcode, FR-81). */
export interface TemplateInfo {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly tags: readonly string[];
  /** Pfade der Quelldateien relativ zum Template. */
  readonly files: readonly string[];
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly durationSeconds: number;
}

/** Katalog aller Templates. */
export interface TemplateCatalog {
  list(): readonly TemplateInfo[];
  /** Quellcode und IR eines Templates. */
  get(name: string): Promise<{ readonly info: TemplateInfo; readonly project: Readonly<Record<string, unknown>>; readonly files: Readonly<Record<string, string>> }>;
}

/** Ergebnis eines Asset-Imports. */
export interface ImportedAsset {
  readonly id: string;
  readonly type: string;
  readonly src: string;
  readonly hash: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly diagnostics: readonly Diagnostic[];
}

/** Asset-Dienste (Paket `assets`). */
export interface AssetService {
  import(projectDir: string, input: { readonly path?: string; readonly url?: string; readonly base64?: string; readonly fileName?: string; readonly id?: string; readonly type?: string }): Promise<ImportedAsset>;
  inspect(projectDir: string, project: Readonly<Record<string, unknown>>, assetId: string): Promise<Readonly<Record<string, unknown>>>;
}

/** Quellcode-Dienste für TSX-Projekte (Paket `compiler`). */
export interface SourceService {
  /** Kompiliert die TSX-Quelle eines Projekts (in der Sandbox) zur IR. */
  compile(projectDir: string, entry: string): Promise<{ readonly project: Record<string, unknown>; readonly diagnostics: readonly Diagnostic[] }>;
  /** Schreibt Patches per AST in die Quelle zurück. */
  writeBack(projectDir: string, entry: string, patches: readonly Patch[]): Promise<{ readonly applied: number; readonly diagnostics: readonly Diagnostic[] }>;
}

/** Alle Dienste der Agent API. */
export interface AgentServices {
  readonly workspace: Workspace;
  readonly jobs: JobManager;
  readonly telemetry: Telemetry;
  /** `container`: Agent-Code nur im Container (Standard, ADR 0008). `trusted`: eigene Projekte auf dem Host. */
  readonly isolation: 'container' | 'trusted';
  /**
   * Leiht eine Render-Umgebung für ein Projekt (Assets und Fonts aufgelöst) für die Dauer von `fn` aus.
   * Der Host zählt Referenzen: Eine Umgebung wird erst entsorgt, wenn niemand sie mehr nutzt.
   */
  readonly withEnvironment: <T>(projectDir: string, project: Readonly<Record<string, unknown>>, fn: (env: RenderEnvironment) => Promise<T>) => Promise<T>;
  /** PNG-Kodierung für Bildergebnisse. */
  readonly encodePng: (image: RgbaImage) => Uint8Array;
  readonly templates?: TemplateCatalog;
  readonly assets?: AssetService;
  readonly sources?: SourceService;
  /** Paralleles Chunk-Rendering (Scheduler); ohne Angabe rendert der Prozess selbst. */
  readonly chunkRunner?: (env: RenderEnvironment, project: Readonly<Record<string, unknown>>) => ChunkRunner;
  /** Benchmarks (Paket `benchmarks`). */
  readonly benchmark?: (input: Readonly<Record<string, unknown>>) => Promise<unknown>;
}
