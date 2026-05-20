import { describe, it, expect } from 'vitest'
import { feature, requiredPlan } from '../src/lib/plan'

describe('feature', () => {
  it('all features are unlocked on every plan', () => {
    const features = [
      'GROUPS',
      'IAM',
      'SSO_GOOGLE',
      'SSO_KEYCLOAK',
      'SSO_OKTA',
      'BANNER',
      'BRANDING',
      'AUDIT_LOG',
    ] as const
    const plans = ['FREE', 'TEAM', 'ENTERPRISE'] as const
    for (const f of features) {
      for (const p of plans) {
        expect(feature(f, p)).toBe(true)
      }
    }
  })
})

describe('requiredPlan', () => {
  it('returns minimum plan for each feature (metadata preserved)', () => {
    expect(requiredPlan('GROUPS')).toBe('TEAM')
    expect(requiredPlan('IAM')).toBe('TEAM')
    expect(requiredPlan('SSO_GOOGLE')).toBe('TEAM')
    expect(requiredPlan('SSO_KEYCLOAK')).toBe('ENTERPRISE')
    expect(requiredPlan('SSO_OKTA')).toBe('ENTERPRISE')
    expect(requiredPlan('BANNER')).toBe('TEAM')
    expect(requiredPlan('AUDIT_LOG')).toBe('ENTERPRISE')
  })
})
