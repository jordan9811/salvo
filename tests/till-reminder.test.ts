/**
 * "Remind me at…": the calendar file the account page makes on the phone
 * (unified-account spec 10.4; src/lib/account/client/reminder.ts).
 *
 * Pinned:
 *   - one event with an alert at its start, at the shopper's own clock (a
 *     floating time), weekly or once;
 *   - it links the store's till, and says nothing else about the shopper;
 *   - the file is valid RFC 5545 text: CRLF lines, folded at 75 octets and
 *     never inside a character, TEXT values escaped;
 *   - a time that is not one is refused, never written as a wrong date;
 *   - the account page makes and saves it in the browser: no request.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { floatingTime, reminderFileName, reminderIcs, type ReminderInput } from '@/lib/account/client/reminder'

const BASE: ReminderInput = {
  store: 'target',
  storeName: 'Target',
  at: '2026-10-13T17:30',
  weekly: true,
  origin: 'https://salvo.example/',
  now: new Date('2026-10-12T15:04:05.678Z'),
  uid: '6f1c2b0e-0000-4000-8000-000000000001',
}

/** The file's content lines, unfolded. */
function unfold(ics: string): string[] {
  return ics.replace(/\r\n /g, '').split('\r\n').filter((l) => l !== '')
}

describe('the reminder file', () => {
  it('is one event, at a floating local time, with an alert when it starts', () => {
    const lines = unfold(reminderIcs(BASE))
    expect(lines[0]).toBe('BEGIN:VCALENDAR')
    expect(lines.at(-1)).toBe('END:VCALENDAR')
    expect(lines.filter((l) => l === 'BEGIN:VEVENT')).toHaveLength(1)
    // No zone and no Z: 5:30 pm wherever the shopper is.
    expect(lines).toContain('DTSTART:20261013T173000')
    expect(lines).toContain('DTSTAMP:20261012T150405Z')
    expect(lines).toContain('DURATION:PT15M')
    expect(lines).toContain('RRULE:FREQ=WEEKLY')
    const alarm = lines.slice(lines.indexOf('BEGIN:VALARM'), lines.indexOf('END:VALARM') + 1)
    expect(alarm).toEqual(['BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Pay less at Target with Salvo', 'TRIGGER:PT0S', 'END:VALARM'])
  })

  it('happens once without weekly', () => {
    expect(unfold(reminderIcs({ ...BASE, weekly: false })).some((l) => l.startsWith('RRULE'))).toBe(false)
  })

  it('links the store till, and carries nothing about the shopper', () => {
    const lines = unfold(reminderIcs(BASE))
    expect(lines).toContain('URL:https://salvo.example/pay/target')
    expect(lines).toContain('SUMMARY:Pay less at Target with Salvo')
    expect(lines).toContain('DESCRIPTION:Open Salvo at Target before you pay: https://salvo.example/pay/target')
    expect(lines).toContain(`UID:${BASE.uid}@salvo`)
    // Every line is one we wrote: no attendee, organizer, location or contact.
    const keys = new Set(lines.map((l) => l.split(/[:;]/)[0]))
    expect([...keys].sort()).toEqual(
      ['ACTION', 'BEGIN', 'CALSCALE', 'DESCRIPTION', 'DTSTAMP', 'DTSTART', 'DURATION', 'END', 'METHOD', 'PRODID', 'RRULE', 'SUMMARY', 'TRIGGER', 'UID', 'URL', 'VERSION'].sort(),
    )
  })

  it('ends every line with CRLF and folds at 75 octets without splitting a character', () => {
    const long = { ...BASE, storeName: 'Best Buy · a store name long enough to need folding, twice over, at least' }
    const ics = reminderIcs(long)
    expect(ics.endsWith('\r\n')).toBe(true)
    expect(ics.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/)
    const physical = ics.split('\r\n').filter((l) => l !== '')
    const enc = new TextEncoder()
    for (const l of physical) expect(enc.encode(l).length, l).toBeLessThanOrEqual(75)
    expect(physical.some((l) => l.startsWith(' '))).toBe(true)
    // Unfolded, the text is whole: the middle dot came through as one character.
    const desc = unfold(ics).find((l) => l.startsWith('DESCRIPTION:Open'))
    expect(desc).toContain('Best Buy · a store name long enough to need folding\\, twice over\\, at least')
  })

  it('escapes what RFC 5545 TEXT reserves', () => {
    const odd = unfold(reminderIcs({ ...BASE, storeName: 'A; B, C\\D\nE' }))
    expect(odd).toContain('SUMMARY:Pay less at A\\; B\\, C\\\\D\\nE with Salvo')
  })

  it('takes a datetime-local value, with or without seconds, and refuses anything else', () => {
    expect(floatingTime('2026-10-13T17:30')).toBe('20261013T173000')
    expect(floatingTime('2026-10-13T17:30:45')).toBe('20261013T173000')
    expect(floatingTime('2028-02-29T09:00')).toBe('20280229T090000')
    for (const bad of ['', '2026-10-13', '2026-02-30T10:00', '2026-10-13T24:00', '2026-10-13T12:60', '13/10/2026 17:30', '2026-10-13T17:30Z']) {
      expect(floatingTime(bad), bad).toBeNull()
      expect(() => reminderIcs({ ...BASE, at: bad }), bad).toThrow(RangeError)
    }
  })

  it('names the file for its store', () => {
    expect(reminderFileName('target')).toBe('salvo-target-reminder.ics')
  })
})

describe('the account page', () => {
  it('makes the file in the browser and sends it nowhere', () => {
    const page = readFileSync(resolve(process.cwd(), 'src/app/account/account-client.tsx'), 'utf8')
    const start = page.indexOf('function Reminder(')
    const end = page.indexOf('\n}\n', start)
    expect(start).toBeGreaterThan(0)
    const body = page.slice(start, end)
    expect(body).toContain('reminderIcs(')
    expect(body).toContain('URL.createObjectURL(new Blob([ics]')
    expect(body).not.toMatch(/fetch\(|api\.|navigator\.sendBeacon|XMLHttpRequest/)
  })
})
