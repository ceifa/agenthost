// Custom domains WITHOUT Cloudflare for SaaS.
//
// Serving is already fully handled by the `_domains/{host}` mapping (see
// index.ts + storage.ts) — recording the mapping is all the Worker needs to
// answer requests for a custom host. The two things Cloudflare for SaaS used to
// provide — routing the domain's traffic to this Worker and issuing its TLS
// cert — are instead done once per domain, by the admin, in the Cloudflare
// dashboard: add the domain as a zone in your own account and attach this Worker
// as a Custom Domain (which creates the proxied DNS record and cert for free).
//
// Those steps can't run from the Worker (the customer has to delegate their
// nameservers to Cloudflare), so we just record the mapping and hand back the
// checklist for the admin to complete out of band.

export interface ProvisionResult {
  provisioned: boolean; // always false now — no API-side provisioning happens here
  status: string;
  steps: string[];
}

export function customDomainSetup(host: string): ProvisionResult {
  return {
    provisioned: false,
    status: "mapping recorded — finish the one-time dashboard setup below",
    steps: [
      `Add "${host}" as a site in your Cloudflare account (Free plan is fine) and update its nameservers at the registrar so Universal SSL issues a certificate for it.`,
      `On this Worker, go to Settings → Domains & Routes → Add Custom Domain and enter "${host}" — Cloudflare creates the proxied DNS record and cert automatically.`,
      `That's it: traffic for "${host}" now reaches the Worker and this mapping serves the site.`,
    ],
  };
}

const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

// A custom domain as the Host router will see it (lowercase, no trailing dot),
// or null if it isn't a hostname or belongs to the apex, whose hosts never
// reach the custom-domain lookup.
export function normalizeHost(raw: string, apexHost: string): string | null {
  const host = raw.trim().toLowerCase().replace(/\.$/, "");
  const apex = apexHost.toLowerCase();
  if (!HOSTNAME.test(host) || host === apex || host.endsWith(`.${apex}`)) return null;
  return host;
}
