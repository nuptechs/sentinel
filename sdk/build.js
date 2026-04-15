#!/usr/bin/env node

// ─────────────────────────────────────────────
// Sentinel SDK — Build Pipeline
// Produces ESM, UMD (browser global), and CDN bundles
// ─────────────────────────────────────────────

import { build } from 'esbuild';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const outdir = path.resolve(import.meta.dirname, '../dist/sdk');
if (!existsSync(outdir)) mkdirSync(outdir, { recursive: true });

const EXTERNAL_PEER_DEPS = ['rrweb', 'html2canvas'];

const shared = {
  entryPoints: [path.resolve(import.meta.dirname, '../src/sdk/index.js')],
  bundle: true,
  sourcemap: true,
  target: ['es2022', 'chrome90', 'firefox90', 'safari15'],
  external: EXTERNAL_PEER_DEPS,
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  logLevel: 'info',
};

async function run() {
  // 1. ESM — for npm/bundler consumers
  await build({
    ...shared,
    format: 'esm',
    outfile: path.join(outdir, 'sentinel.esm.js'),
  });

  // 2. UMD / IIFE — for CDN / <script> tag
  await build({
    ...shared,
    format: 'iife',
    globalName: 'Sentinel',
    outfile: path.join(outdir, 'sentinel.iife.js'),
    // For CDN bundle, inline peer deps aren't available — mark as external
    // Users must load rrweb/html2canvas separately
    footer: {
      js: `if(typeof module!=="undefined")module.exports=Sentinel;`,
    },
  });

  // 3. CDN bundle — self-contained (no external deps except rrweb/html2canvas)
  await build({
    ...shared,
    format: 'iife',
    globalName: 'Sentinel',
    outfile: path.join(outdir, 'sentinel.cdn.js'),
    minify: true,
    footer: {
      js: `if(typeof module!=="undefined")module.exports=Sentinel;`,
    },
  });

  // 4. Generate TypeScript declarations stub
  writeFileSync(
    path.join(outdir, 'sentinel.d.ts'),
    generateTypeDeclarations(),
    'utf-8',
  );

  console.log('[Sentinel SDK] Build complete → dist/sdk/');
}

function generateTypeDeclarations() {
  return `// Auto-generated type declarations for @nuptech/sentinel/sdk
// See src/sdk/index.js for full documentation

export interface SentinelInitOptions {
  serverUrl: string;
  projectId: string;
  userId?: string;
  apiKey?: string;
  metadata?: Record<string, unknown>;

  // Recording options
  captureDOM?: boolean;
  captureNetwork?: boolean;
  captureConsole?: boolean;
  captureErrors?: boolean;
  sampling?: { sessionRate?: number; errorRate?: number };

  // Annotator options
  annotator?: boolean;
  annotatorPosition?: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';

  // Media options
  enableAudio?: boolean;
  enableVideo?: boolean;

  // Transport options
  batchSize?: number;
  flushInterval?: number;
  maxBufferSize?: number;

  // Integration options
  integrations?: Integration[];
}

export interface SentinelInstance {
  session: { id: string; [key: string]: unknown };
  reporter: Reporter;
  recorder: Recorder;
  annotator: Annotator | null;
  report(finding: Record<string, unknown>): Promise<unknown>;
  stop(): Promise<void>;
  addIntegration(integration: Integration): void;
}

export interface Integration {
  name: string;
  setup(context: IntegrationContext): void | Promise<void>;
  teardown(): void;
}

export interface IntegrationContext {
  reporter: Reporter;
  recorder: Recorder;
  shadowHost: ShadowHost;
  options: SentinelInitOptions;
}

export declare class Reporter {
  readonly sessionId: string | null;
  startSession(opts?: { userId?: string; metadata?: Record<string, unknown> }): Promise<{ id: string }>;
  push(events: Record<string, unknown> | Record<string, unknown>[]): void;
  flush(): Promise<void>;
  reportFinding(finding: Record<string, unknown>): Promise<{ id: string }>;
  suggestTitle(opts: Record<string, unknown>): Promise<Record<string, unknown>>;
  endSession(): Promise<void>;
  destroy(): void;
}

export declare class Recorder {
  readonly isRunning: boolean;
  readonly isSampled: boolean;
  start(): Promise<void>;
  stop(): void;
}

export declare class Annotator {
  mount(): void;
  unmount(): void;
}

export declare class ShadowHost {
  readonly root: ShadowRoot;
  createElement(tag: string, className?: string): HTMLElement;
  injectCSS(css: string): void;
}

export declare function init(options: SentinelInitOptions): Promise<SentinelInstance>;
`;
}

run().catch((err) => {
  console.error('[Sentinel SDK] Build failed:', err);
  process.exit(1);
});
