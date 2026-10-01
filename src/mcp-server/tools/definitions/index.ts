/**
 * @fileoverview Every tool definition this server registers, collected for `createApp()`.
 * @module mcp-server/tools/definitions
 */

import { exportCitationsTool } from './export-citations.tool.js';
import { getCitationSummaryTool } from './get-citation-summary.tool.js';
import { getPaperTool } from './get-paper.tool.js';
import { listReferenceTool } from './list-reference.tool.js';
import { searchAuthorsTool } from './search-authors.tool.js';
import { searchExperimentsTool } from './search-experiments.tool.js';
import { searchHepdataTool } from './search-hepdata.tool.js';
import { searchLiteratureTool } from './search-literature.tool.js';

export const allToolDefinitions = [
  searchLiteratureTool,
  getPaperTool,
  exportCitationsTool,
  searchAuthorsTool,
  getCitationSummaryTool,
  searchExperimentsTool,
  searchHepdataTool,
  listReferenceTool,
];
