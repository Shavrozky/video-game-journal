#!/usr/bin/env node
/**
 * Personal library maintenance CLI.
 *
 *   npm run db:migrate        create/upgrade the schema (idempotent)
 *   npm run db:seed           import the 16 legacy backlog entries (idempotent)
 *   npm run db:backup         copy the database + WAL into .data/backups/
 *   npm run db:status         print schema version, row counts, file paths
 *   npm run db:restore <file> replace the live database with a backup
 *
 * The heavy lifting lives in `scripts/db/maintenance.mjs`, which talks to SQLite
 * directly so it can run without Astro or a dev server.
 */

import { pathToFileURL } from 'node:url';
import path from 'node:path';

const entry = pathToFileURL(path.join(import.meta.dirname, 'maintenance.mjs')).href;
await import(entry);
