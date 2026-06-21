import { describe, it, expect } from 'vitest';
import { industryToTag, mapContactProperties } from './hubspot-map.js';
import type { Lead } from './types.js';

describe('industryToTag', () => {
  it('slugifies a multi-word industry', () => {
    expect(industryToTag('immigration lawyer')).toEqual({
      value: 'Immigration_Lawyer',
      label: 'Immigration Lawyer',
    });
  });
  it('handles a single word', () => {
    expect(industryToTag('dentist')).toEqual({ value: 'Dentist', label: 'Dentist' });
  });
});

describe('mapContactProperties', () => {
  const lead: Lead = {
    title: 'Acme Law',
    email: 'info@acmelaw.com',
    phone: '(212) 555-0188',
    website: 'https://acmelaw.com',
    address: '5 Main St',
    linkedin: 'https://linkedin.com/company/acme',
    googleMapsLink: 'https://maps.google.com/?cid=1',
  };

  it('maps standard fields and drops empties', () => {
    const props = mapContactProperties(lead, { existingProps: new Set() });
    expect(props.email).toBe('info@acmelaw.com');
    expect(props.company).toBe('Acme Law');
    expect(props.website).toBe('https://acmelaw.com');
    // No custom props sent when the account has none.
    expect(props.source).toBeUndefined();
    expect(props.linkedin_url).toBeUndefined();
  });

  it('includes custom props only when they exist in the account', () => {
    const existingProps = new Set(['source', 'statut_outbound', 'linkedin_url', 'google_maps_link', 'type_contact']);
    const props = mapContactProperties(lead, {
      industry: 'immigration lawyer',
      existingProps,
      typeContactValue: 'Immigration_Lawyer',
    });
    expect(props.source).toBe('Google_Maps');
    expect(props.statut_outbound).toBe('To_Contact');
    expect(props.linkedin_url).toBe('https://linkedin.com/company/acme');
    expect(props.google_maps_link).toBe('https://maps.google.com/?cid=1');
    expect(props.type_contact).toBe('Immigration_Lawyer');
  });

  it('omits type_contact when typeContactValue is not provided', () => {
    const existingProps = new Set(['type_contact']);
    const props = mapContactProperties(lead, { industry: 'x', existingProps });
    expect(props.type_contact).toBeUndefined();
  });
});
