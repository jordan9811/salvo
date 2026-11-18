/**
 * Test setup for the public repo: fixed settings, no database, no network,
 * no .env. Nothing here can reach a real email, push or payment service.
 */

// @types/node marks NODE_ENV readonly; a typed mutable view keeps this honest.
const env: Record<string, string | undefined> = process.env

env.NODE_ENV = 'test'
env.APP_URL = 'http://localhost:3000'
env.OPERATOR_SECRET = 'test-operator-secret-at-least-16-chars'
// Empty, not unset: the app treats an empty value as "not configured".
env.RESEND_API_KEY = ''
env.NTFY_TOPIC = ''
