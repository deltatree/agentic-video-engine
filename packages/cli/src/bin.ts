#!/usr/bin/env node
/**
 * Einstiegspunkt der Kommandozeile `openvideo`.
 */
import { runCli } from './cli.js';

const code = await runCli(process.argv.slice(2), {
  stdout: (t) => process.stdout.write(t),
  stderr: (t) => process.stderr.write(t),
  cwd: process.cwd(),
  env: process.env,
});
process.exitCode = code;
