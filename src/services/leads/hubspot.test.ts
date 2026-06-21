import { describe, it, expect, vi } from 'vitest';
import { pushContacts } from './hubspot.js';
import type { Lead } from './types.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const lead: Lead = { title: 'Acme Law', email: 'info@acmelaw.com', phone: '(212) 555-0188' };

describe('pushContacts', () => {
  it('creates a new contact when none exists', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/properties/contacts')) return jsonResponse({ results: [] });
      if (u.includes('/contacts/search')) return jsonResponse({ results: [] });
      if (u.includes('/objects/contacts')) return jsonResponse({ id: '999' }, 201);
      return jsonResponse({}, 404);
    }) as unknown as typeof fetch;

    const result = await pushContacts({ token: 'pat-x', leads: [lead], dryRun: false, fetchImpl });
    expect(result.created).toBe(1);
    expect(result.results[0]).toMatchObject({ status: 'created', hubspotId: '999' });
  });

  it('skips a contact that already exists (dedup by email)', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('/properties/contacts')) return jsonResponse({ results: [] });
      if (u.includes('/contacts/search')) return jsonResponse({ results: [{ id: '111' }] });
      return jsonResponse({}, 500); // create must NOT be called
    }) as unknown as typeof fetch;

    const result = await pushContacts({ token: 'pat-x', leads: [lead], dryRun: false, fetchImpl });
    expect(result.skipped).toBe(1);
    expect(result.results[0]).toMatchObject({ status: 'exists', hubspotId: '111' });
  });

  it('dryRun does not call the create endpoint', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      calls.push(u);
      if (u.includes('/properties/contacts')) return jsonResponse({ results: [] });
      if (u.includes('/contacts/search')) return jsonResponse({ results: [] });
      return jsonResponse({}, 500);
    }) as unknown as typeof fetch;

    const result = await pushContacts({ token: 'pat-x', leads: [lead], dryRun: true, fetchImpl });
    expect(result.created).toBe(1); // reported as would-create
    expect(calls.some((c) => c.includes('/objects/contacts') && !c.includes('search'))).toBe(false);
  });

  it('continues the batch after a failed lead', async () => {
    let createCalls = 0;
    let searchCalled = false;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('/properties/contacts')) return jsonResponse({ results: [] });
      if (u.includes('/contacts/search')) {
        searchCalled = true;
        return jsonResponse({ results: [] });
      }
      if (u.includes('/objects/contacts')) {
        createCalls += 1;
        // First create fails (non-retryable 400); second succeeds.
        return createCalls === 1 ? jsonResponse({ message: 'bad' }, 400) : jsonResponse({ id: '777' }, 201);
      }
      return jsonResponse({}, 404);
    }) as unknown as typeof fetch;

    const leads = [lead, { title: 'Beta Corp', email: 'beta@beta.com', phone: '' }];
    const result = await pushContacts({ token: 'pat-x', leads, dryRun: false, fetchImpl });

    expect(result.failed).toBe(1);
    expect(result.created).toBe(1);
    expect(result.results[0]!.status).toBe('failed');
    expect(result.results[0]!.error).toBeTruthy();
    expect(result.results[1]!).toMatchObject({ status: 'created', hubspotId: '777' });
    expect(searchCalled).toBe(true);
  });

  it('auto-creates a missing type_contact option, then tags the contact', async () => {
    let patched = false;
    let sentProps: Record<string, string> = {};
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      // Single-property GET/PATCH — check before the generic property list.
      if (u.includes('/properties/contacts/type_contact')) {
        if (init?.method === 'PATCH') {
          patched = true;
          return jsonResponse({}, 200);
        }
        return jsonResponse({ options: [{ label: 'Dentist', value: 'Dentist', displayOrder: 0 }] });
      }
      if (u.includes('/properties/contacts')) return jsonResponse({ results: [{ name: 'type_contact' }] });
      if (u.includes('/contacts/search')) return jsonResponse({ results: [] });
      if (u.includes('/objects/contacts')) {
        sentProps = JSON.parse(String(init?.body)).properties;
        return jsonResponse({ id: '900' }, 201);
      }
      return jsonResponse({}, 404);
    }) as unknown as typeof fetch;

    const result = await pushContacts({
      token: 'pat-x',
      leads: [lead],
      industry: 'immigration lawyer',
      dryRun: false,
      fetchImpl,
    });
    expect(result.created).toBe(1);
    expect(patched).toBe(true);
    expect(sentProps.type_contact).toBe('Immigration_Lawyer');
  });

  it('does not PATCH when the type_contact option already exists', async () => {
    let patched = false;
    let sentProps: Record<string, string> = {};
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/properties/contacts/type_contact')) {
        if (init?.method === 'PATCH') {
          patched = true;
          return jsonResponse({}, 200);
        }
        return jsonResponse({
          options: [{ label: 'Immigration Lawyer', value: 'Immigration_Lawyer', displayOrder: 0 }],
        });
      }
      if (u.includes('/properties/contacts')) return jsonResponse({ results: [{ name: 'type_contact' }] });
      if (u.includes('/contacts/search')) return jsonResponse({ results: [] });
      if (u.includes('/objects/contacts')) {
        sentProps = JSON.parse(String(init?.body)).properties;
        return jsonResponse({ id: '901' }, 201);
      }
      return jsonResponse({}, 404);
    }) as unknown as typeof fetch;

    const result = await pushContacts({
      token: 'pat-x',
      leads: [lead],
      industry: 'immigration lawyer',
      dryRun: false,
      fetchImpl,
    });
    expect(result.created).toBe(1);
    expect(patched).toBe(false);
    expect(sentProps.type_contact).toBe('Immigration_Lawyer');
  });

  it('omits type_contact (but still creates the contact) when the option cannot be ensured', async () => {
    let sentProps: Record<string, string> = {};
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      // Property GET fails (e.g. missing schema scope) -> cannot ensure option.
      if (u.includes('/properties/contacts/type_contact')) return jsonResponse({}, 403);
      if (u.includes('/properties/contacts')) return jsonResponse({ results: [{ name: 'type_contact' }] });
      if (u.includes('/contacts/search')) return jsonResponse({ results: [] });
      if (u.includes('/objects/contacts')) {
        sentProps = JSON.parse(String(init?.body)).properties;
        return jsonResponse({ id: '902' }, 201);
      }
      return jsonResponse({}, 404);
    }) as unknown as typeof fetch;

    const result = await pushContacts({
      token: 'pat-x',
      leads: [lead],
      industry: 'immigration lawyer',
      dryRun: false,
      fetchImpl,
    });
    expect(result.created).toBe(1);
    expect(sentProps.type_contact).toBeUndefined();
  });
});
