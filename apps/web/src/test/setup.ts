import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// Testing Library only auto-registers its cleanup when the test runner
// exposes `afterEach` as a global; this project imports from 'vitest'
// explicitly instead of enabling globals, so register it by hand — otherwise
// rendered components leak between tests.
afterEach(() => {
  cleanup()
})
