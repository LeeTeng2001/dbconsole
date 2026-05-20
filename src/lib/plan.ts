export type PlanTier = 'FREE' | 'TEAM' | 'ENTERPRISE'

// Plan ordering removed: all features are unlocked regardless of plan tier.
// The FEATURE_PLAN map is kept only as metadata for `requiredPlan()`, which
// is used by the UI for display labels (e.g. "Requires TEAM plan").

const FEATURE_PLAN = {
  GROUPS: 'TEAM',
  IAM: 'TEAM',
  SSO_GOOGLE: 'TEAM',
  SSO_KEYCLOAK: 'ENTERPRISE',
  SSO_OKTA: 'ENTERPRISE',
  BANNER: 'TEAM',
  BRANDING: 'ENTERPRISE',
  AUDIT_LOG: 'ENTERPRISE',
} as const

export type Feature = keyof typeof FEATURE_PLAN

export function feature(_name: Feature, _plan: PlanTier): boolean {
  // All features unlocked.
  return true
}

export function requiredPlan(name: Feature): PlanTier {
  return FEATURE_PLAN[name]
}
