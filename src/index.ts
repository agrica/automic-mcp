#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { main } from './main.js';

const exitCode = main(process.env, serveStdio);
if (exitCode !== 0) process.exitCode = exitCode;
