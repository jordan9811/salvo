/**
 * "Remind me at…": a calendar reminder to open a store's till, made on the
 * phone (unified-account spec 10.4).
 *
 * ===========================================================================
 * WHY A CALENDAR FILE, AND NOTHING ON OUR SIDE. With location off, a Wallet
 * store card cannot come up on dates alone (spec 10.4), and a pushed alert
 * needs a table we do not have yet (phase 5). The phone's own calendar can
 * remind at a time with nothing of ours involved: this builds one event, the
 * shopper's calendar keeps it, and our server never hears of it.
 *
 * FLOATING LOCAL TIME. The event says "5:30 pm", not "5:30 pm in Austin":
 * a reminder to shop is about the shopper's own clock, wherever they are.
 * RFC 5545 calls that a floating time, a DTSTART with no zone.
 * ===========================================================================
 *
 * Pure: the account page passes the clock, the id and the site's origin.
 */

/** What the reminder is for and when. `at` is a datetime-local value: "2026-10-13T17:30", seconds ignored. */
export interface ReminderInput {
  store: string
  storeName: string
  at: string
  /** Every week at that time, or once. */
  weekly: boolean
  /** The site's origin, for the till's link: "https://salvo.example". */
  origin: string
  now: Date
  /** Unique per reminder, so a second one is a second event, not a replacement. */
  uid: string
}

/** A browser may add seconds to a datetime-local value; a reminder has no use for them. */
const AT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/

/** A datetime-local value as an RFC 5545 floating date-time, or null when it is not one. */
export function floatingTime(at: string): string | null {
  const m = AT_RE.exec(at)
  if (m === null) return null
  const [, y, mo, d, h, mi] = m.map(Number) as [number, number, number, number, number, number]
  const probe = new Date(Date.UTC(y, mo - 1, d, h, mi))
  // Rejects the 31st of a short month, hour 24 and the like.
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d || probe.getUTCHours() !== h) {
    return null
  }
  return `${at.slice(0, 4)}${at.slice(5, 7)}${at.slice(8, 10)}T${at.slice(11, 13)}${at.slice(14, 16)}00`
}

/** RFC 5545 TEXT: backslash, semicolon, comma and newline escaped. */
function text(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
}

/**
 * One content line folded at 75 octets, as RFC 5545 asks: CRLF and a space,
 * and never inside a multi-byte character ("·" is two).
 */
function fold(line: string): string {
  const enc = new TextEncoder()
  const out: string[] = []
  let current = ''
  let octets = 0
  for (const ch of line) {
    const n = enc.encode(ch).length
    // The first line holds 75 octets; each folded one holds 74 after its leading space.
    if (octets + n > (out.length === 0 ? 75 : 74)) {
      out.push(current)
      current = ''
      octets = 0
    }
    current += ch
    octets += n
  }
  out.push(current)
  return out.join('\r\n ')
}

function utcStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

/** The .ics file: one event with an alert at its start. Throws on a time that is not one. */
export function reminderIcs(r: ReminderInput): string {
  const start = floatingTime(r.at)
  if (start === null) throw new RangeError('pick a day and a time')
  const url = `${r.origin.replace(/\/+$/, '')}/pay/${r.store}`
  const title = `Pay less at ${r.storeName} with Salvo`
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Salvo//Till reminder//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${text(r.uid)}@salvo`,
    `DTSTAMP:${utcStamp(r.now)}`,
    `DTSTART:${start}`,
    'DURATION:PT15M',
    ...(r.weekly ? ['RRULE:FREQ=WEEKLY'] : []),
    `SUMMARY:${text(title)}`,
    `DESCRIPTION:${text(`Open Salvo at ${r.storeName} before you pay: ${url}`)}`,
    `URL:${url}`,
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${text(title)}`,
    'TRIGGER:PT0S',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ]
  return lines.map(fold).join('\r\n') + '\r\n'
}

/** "salvo-target-reminder.ics". */
export function reminderFileName(store: string): string {
  return `salvo-${store}-reminder.ics`
}
