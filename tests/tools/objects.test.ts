import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  exportedType,
  nextSearchIndex,
  normalizeFolder,
  objectFingerprint,
} from '../../src/tools/objects.js';
import { UNTRUSTED_NOTICE } from '../../src/tools/result.js';
import { objectNotFound, searchResult } from '../fixtures/observed.js';
import { fakeFetch, json } from '../helpers/fetch.js';
import { connect, textOf } from '../helpers/mcp.js';

describe('objectFingerprint', () => {
  const data = { scri: { general_attributes: { type: 'SCRI', name: 'X' }, scripts: [{ process: ':PRINT 1' }] } };

  it('ignores key order and whitespace, but not array order', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: null, c: 'x' }] })).toBe('{"a":[2,{"c":"x","d":null}],"b":1}');
    const reordered = { scri: { scripts: [{ process: ':PRINT 1' }], general_attributes: { name: 'X', type: 'SCRI' } } };
    expect(objectFingerprint(reordered)).toBe(objectFingerprint(data));
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('changes with any change of the definition (e.g. an added activation)', () => {
    const changed = structuredClone(data);
    changed.scri.scripts[0]!.process = ":PRINT 1\n:SET &R# = ACTIVATE_UC_OBJECT('MCP.OUTSIDE.X')";
    expect(objectFingerprint(changed)).not.toBe(objectFingerprint(data));
    expect(objectFingerprint(data)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('normalizeFolder', () => {
  it.each([
    ['TEAM/APP', '\\TEAM\\APP'],
    ['/TEAM/APP/', '\\TEAM\\APP'],
    ['\\TEAM\\APP', '\\TEAM\\APP'],
    ['TEAM', '\\TEAM'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeFolder(input)).toBe(expected);
  });

  it.each(['/', 'TEAM/../X', './TEAM'])('refuses %s', (input) => {
    expect(() => normalizeFolder(input)).toThrow(/at least one folder/);
  });
});

describe('automic_search_objects', () => {
  it('builds the observed filter shapes and returns the validated fields only', async () => {
    const { fetch, calls } = fakeFetch(json(searchResult));
    const { client } = await connect(fetch);
    const result = await client.callTool({
      name: 'automic_search_objects',
      arguments: { name: 'APP.*', folder: 'TEAM/APP', types: ['JOBS'], maxResults: 10 },
    });
    expect(calls[0]!.url.pathname).toBe('/ae/api/v1/400/search');
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      max_results: 10,
      start_at: 0,
      filters: [
        { filter_identifier: 'object_name', object_name: 'APP.*' },
        { filter_identifier: 'location', location: '\\TEAM\\APP', include_subfolders: true },
        { filter_identifier: 'object_type', object_types: ['JOBS'] },
      ],
    });
    const output = JSON.parse(textOf(result));
    expect(output).toMatchObject({ total: 1, hasmore: false, returned: 1, next_start_at: null, warnings: [] });
    expect(Object.keys(output.objects[0]).sort()).toEqual(
      [
        'folder_path',
        'is_inactive',
        'modified_by',
        'modified_date',
        'name',
        'platform',
        'sub_type',
        'title',
        'type',
      ].sort(),
    );
  });

  it('gives the next start index when more results exist', async () => {
    const { fetch } = fakeFetch(json({ ...searchResult, total: 30, hasmore: true }));
    const { client } = await connect(fetch);
    const result = await client.callTool({ name: 'automic_search_objects', arguments: { name: 'A*', startAt: 20 } });
    expect(JSON.parse(textOf(result))).toMatchObject({ next_start_at: 21, warnings: [] });
  });

  it('follows the documented index even when hasmore disagrees with total, and says so', async () => {
    const { fetch } = fakeFetch(json({ ...searchResult, total: 30, hasmore: false, indexing_in_progress: true }));
    const { client } = await connect(fetch);
    const result = await client.callTool({ name: 'automic_search_objects', arguments: { name: 'A*' } });
    expect(JSON.parse(textOf(result))).toMatchObject({
      next_start_at: 1,
      warnings: [
        'the search index is being updated: results may be incomplete',
        'hasmore=false disagrees with total=30',
      ],
    });
  });

  it('refuses a search without criterion, without HTTP', async () => {
    const { fetch, calls } = fakeFetch();
    const { client } = await connect(fetch);
    const result = await client.callTool({ name: 'automic_search_objects', arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Provide at least one of name, folder or types');
    expect(calls).toHaveLength(0);
  });
});

describe('nextSearchIndex', () => {
  it('moves forward only on a non-empty page with more matches', () => {
    expect(nextSearchIndex(0, 10, 25, false)).toBe(10);
    expect(nextSearchIndex(20, 5, 25, false)).toBeNull();
    expect(nextSearchIndex(20, 5, 25, true)).toBe(25);
    // An empty page never yields an index (no progress possible).
    expect(nextSearchIndex(10, 0, 25, true)).toBeNull();
  });
});

describe('automic_get_object', () => {
  const exportOf = (key: string, type: string, extra: Record<string, unknown> = {}) => ({
    total: 1,
    path: 'TEAM/APP',
    client: 400,
    hasmore: false,
    data: { [key]: { general_attributes: { type, name: 'X' }, ...extra } },
  });

  it('accepts exactly one allowlisted object whose key matches its declared type', () => {
    expect(exportedType({ jobp: { general_attributes: { type: 'JOBP' } } })).toBe('JOBP');
  });

  it.each([
    [{}, 'expected one object, got 0'],
    [{ jobs: { general_attributes: { type: 'JOBS' } }, conn: { general_attributes: { type: 'CONN' } } }, 'got 2'],
    [{ jobs: {} }, 'the object type is not declared'],
    [{ jobs: { general_attributes: { type: 'CONN' } } }, 'inconsistent object type'],
    [{ xyz: { general_attributes: { type: 'XYZ' } } }, 'Export of XYZ objects is not allowed'],
  ])('refuses an unknown or inconsistent export %#', (data, message) => {
    expect(() => exportedType(data)).toThrow(message);
  });

  it('returns an encoded-name export as flagged untrusted data with secrets masked', async () => {
    const body = exportOf('jobs', 'JOBS', { scripts: [{ process: ['echo password=hunter2'] }] });
    const { fetch, calls } = fakeFetch(json(body));
    const { client } = await connect(fetch);
    const result = await client.callTool({ name: 'automic_get_object', arguments: { name: 'APP#JOB' } });
    expect(calls[0]!.url.pathname).toBe('/ae/api/v1/400/objects/APP%23JOB');
    expect(JSON.parse(textOf(result, 0))).toEqual({
      name: 'APP#JOB',
      type: 'JOBS',
      path: 'TEAM/APP',
      fingerprint: objectFingerprint(body.data),
    });
    expect(textOf(result, 1).startsWith(UNTRUSTED_NOTICE)).toBe(true);
    expect(textOf(result, 1)).toContain('password=***');
    expect(textOf(result, 1)).not.toContain('hunter2');
  });

  it.each(['LOGIN', 'CONN', 'CERT'])('refuses to export %s objects', async (type) => {
    const { fetch } = fakeFetch(json(exportOf(type.toLowerCase(), type)));
    const { client } = await connect(fetch);
    const result = await client.callTool({ name: 'automic_get_object', arguments: { name: 'X' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(`Export of ${type} objects is not allowed (they may hold credentials)`);
    expect(textOf(result)).not.toContain('general_attributes');
  });

  it('refuses "." and ".." as names, without HTTP', async () => {
    const { fetch, calls } = fakeFetch();
    const { client } = await connect(fetch);
    const result = await client.callTool({ name: 'automic_get_object', arguments: { name: '..' } });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('surfaces a 404 as a tool error', async () => {
    const { fetch } = fakeFetch(json(objectNotFound, 404));
    const { client } = await connect(fetch);
    const result = await client.callTool({ name: 'automic_get_object', arguments: { name: 'DOES.NOT.EXIST' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Object 'DOES.NOT.EXIST' not found. (code 45212)");
  });
});

describe('automic_get_object_usage', () => {
  it('returns the documented usage structure', async () => {
    const usage = {
      references: [{ name: 'PARENT.JOBP' }],
      number_of_referencing_objects: 1,
      total_number_of_references: 1,
    };
    const { fetch, calls } = fakeFetch(json(usage));
    const { client } = await connect(fetch);
    const result = await client.callTool({ name: 'automic_get_object_usage', arguments: { name: 'CHILD.JOBS' } });
    expect(calls[0]!.url.pathname).toBe('/ae/api/v1/400/objects/CHILD.JOBS/usage');
    expect(JSON.parse(textOf(result))).toEqual(usage);
  });
});
