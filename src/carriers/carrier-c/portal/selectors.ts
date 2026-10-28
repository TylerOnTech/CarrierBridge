/**
 * Every selector and label the scraper depends on lives here. When the portal changes
 * its markup, this file (and only this file) should need editing.
 */
export const SELECTORS = {
  login: {
    page: '[data-testid="login-page"]',
    username: '#username',
    password: '#password',
    submit: '[data-testid="login-submit"]',
    error: '[data-testid="login-error"]',
  },
  dashboard: {
    root: '[data-testid="dashboard"]',
    policyLink: '[data-testid="policy-row"] [data-testid="policy-link"]',
    nextPage: '[data-testid="pagination-next"]',
  },
  policy: {
    root: '[data-testid="policy-detail"]',
    summaryRow: '[data-testid="policy-summary"] .row',
    coverageRow: '[data-testid="coverage-row"]',
    vehiclesSection: '[data-testid="vehicles-section"]',
    vehicle: '[data-testid="vehicle"]',
    driversSection: '[data-testid="drivers-section"]',
    driver: '[data-testid="driver"]',
  },
} as const;

/** Summary labels as rendered by the portal (definition-list <dt> text). */
export const LABELS = {
  policyNumber: 'Policy Number',
  product: 'Product',
  status: 'Status',
  period: 'Policy Period',
  premium: 'Premium',
  namedInsured: 'Named Insured',
} as const;

export const LOGIN_PATH = '/login';
export const DASHBOARD_PATH = '/dashboard';
