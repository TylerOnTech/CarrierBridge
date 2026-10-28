import type { PortalPolicy } from '../data/carrier-c.js';

const esc = (value: unknown): string =>
  String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch);

const layout = (title: string, body: string): string => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)} | Carrier C Customer Portal</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; background: #f4f6f8; color: #1d2733; }
    header { background: #12355b; color: #fff; padding: 12px 24px; }
    main { max-width: 860px; margin: 24px auto; background: #fff; padding: 24px; border-radius: 8px; }
    table { width: 100%; border-collapse: collapse; } td, th { padding: 8px; border-bottom: 1px solid #e3e8ee; text-align: left; }
    dl .row { display: flex; gap: 12px; padding: 4px 0; } dt { width: 180px; font-weight: 600; }
    .banner { padding: 10px; border-radius: 6px; margin-bottom: 12px; }
    .error { background: #fde8e8; color: #8a1c1c; } .info { background: #e8f1fd; color: #12355b; }
  </style>
</head>
<body>
  <header><strong>Carrier C</strong> &middot; Customer Portal (synthetic demo)</header>
  ${body}
</body>
</html>`;

export function loginPage(params: { error?: string; reason?: string; returnTo?: string }): string {
  return layout(
    'Sign in',
    `<main data-testid="login-page">
    <h1>Sign in to your account</h1>
    ${params.reason === 'session_expired' ? '<div class="banner info" data-testid="session-expired-banner">Your session has expired. Please sign in again.</div>' : ''}
    ${params.error ? `<div class="banner error" role="alert" data-testid="login-error">${esc(params.error)}</div>` : ''}
    <form method="post" action="/login" data-testid="login-form">
      <input type="hidden" name="returnTo" value="${esc(params.returnTo ?? '')}">
      <p><label for="username">Username</label><br><input id="username" name="username" autocomplete="username" required></p>
      <p><label for="password">Password</label><br><input id="password" name="password" type="password" autocomplete="current-password" required></p>
      <button type="submit" data-testid="login-submit">Sign in</button>
    </form>
  </main>`,
  );
}

export function dashboardPage(params: {
  fullName: string;
  policies: PortalPolicy[];
  page: number;
  totalPages: number;
}): string {
  const rows = params.policies
    .map(
      (p) => `<tr data-testid="policy-row" data-policy-number="${esc(p.policyNumber)}">
        <td><a data-testid="policy-link" href="/policies/${encodeURIComponent(p.policyNumber)}">${esc(p.policyNumber)}</a></td>
        <td>${esc(p.product)}</td><td>${esc(p.status)}</td></tr>`,
    )
    .join('\n');
  const next =
    params.page < params.totalPages
      ? `<a data-testid="pagination-next" href="/dashboard?page=${params.page + 1}">Next page</a>`
      : '';
  return layout(
    'My policies',
    `<main data-testid="dashboard">
    <p data-testid="welcome">Welcome back, ${esc(params.fullName)}</p>
    <h1>My policies</h1>
    <table data-testid="policy-table">
      <thead><tr><th>Policy</th><th>Product</th><th>Status</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <nav data-testid="pagination">Page ${params.page} of ${params.totalPages} ${next}</nav>
  </main>`,
  );
}

export function policyDetailPage(policy: PortalPolicy, layoutVersion: 'v1' | 'v2'): string {
  const fields: Array<[string, string]> = [
    ['Policy Number', policy.policyNumber],
    ['Product', policy.product],
    ['Status', policy.status],
    ['Policy Period', `${policy.periodStart} – ${policy.periodEnd}`],
    ['Premium', policy.premium ?? 'Not available'],
    ['Named Insured', policy.namedInsured],
  ];
  // v2 simulates an unannounced portal redesign: the summary block's markup changes.
  const summary =
    layoutVersion === 'v1'
      ? `<dl data-testid="policy-summary">${fields.map(([k, v]) => `<div class="row"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>`
      : `<table data-testid="policy-overview">${fields.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table>`;

  const coverages = `<h2>Coverages</h2>
    <table data-testid="coverages-table">
      <thead><tr><th>Coverage</th><th>Limit</th><th>Deductible</th></tr></thead>
      <tbody>${policy.coverages
        .map(
          (c) => `<tr data-testid="coverage-row"><td data-col="coverage">${esc(c.name)}</td>
          <td data-col="limit">${esc(c.limit)}</td><td data-col="deductible">${esc(c.deductible)}</td></tr>`,
        )
        .join('')}</tbody>
    </table>`;

  const vehicles = policy.vehicles
    ? `<section data-testid="vehicles-section"><h2>Vehicles</h2><ul>${policy.vehicles
        .map(
          (v) => `<li data-testid="vehicle"><span data-field="description">${esc(`${v.year} ${v.make} ${v.model}`)}</span>
          &middot; <span data-field="vin">VIN: ${esc(v.vin)}</span></li>`,
        )
        .join('')}</ul></section>`
    : '';

  const drivers = policy.drivers
    ? `<section data-testid="drivers-section"><h2>Drivers</h2><ul>${policy.drivers
        .map((d) => `<li data-testid="driver">${esc(d)}</li>`)
        .join('')}</ul></section>`
    : '';

  return layout(
    `Policy ${policy.policyNumber}`,
    `<main data-testid="policy-detail">
    <p><a href="/dashboard">&larr; Back to my policies</a></p>
    <h1>${esc(policy.product)}</h1>
    ${summary}
    ${coverages}
    ${vehicles}
    ${drivers}
  </main>`,
  );
}

export function notFoundPage(): string {
  return layout('Not found', '<main data-testid="not-found"><h1>Page not found</h1></main>');
}
