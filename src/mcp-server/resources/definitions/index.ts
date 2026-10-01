/**
 * @fileoverview Every resource definition this server registers, collected for `createApp()`.
 * @module mcp-server/resources/definitions
 */

import { inspireLiteratureResource } from './inspire-literature.resource.js';

export const allResourceDefinitions = [inspireLiteratureResource];
