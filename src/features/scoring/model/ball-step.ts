import { dedupeContacts, type ContactEvent, type RideFns, type RideSample } from '@/shared/contacts'
import { findMechanism, flashNote, type PinballDocument } from '@/shared/document'
import { speedOf } from '@/shared/geometry'
import { BodyId } from '@/shared/ids'
import type { Solid } from '@/shared/solids'
import { resolveBall } from '@/features/scoring/lib/collide'
import { awardHole } from '@/features/scoring/model/score-rules'

const MAX_SPEED = 1750
const SCOOP_MS = 560
const RAMP_MS = 920
const HOLE_OFFER_MAX = 5
const HOLE_OFFER_MIN = 1
const HOLE_DECAY_MS = 3500
const HOLE_KICK_VX = -60
const HOLE_KICK_VY = -700

function cooled(doc: PinballDocument, id: string): boolean {
  const mechanism = findMechanism(doc, id)
  return Boolean(mechanism && mechanism.cooldownMs > 0)
}

function capSpeed(doc: PinballDocument, dtMs: number): void {
  const speed = speedOf(doc.ball.vx, doc.ball.vy)
  if (speed > MAX_SPEED) {
    const scale = MAX_SPEED / speed
    doc.ball.vx *= scale
    doc.ball.vy *= scale
  }
  if (speed > 22) {
    doc.ball.idleMs = 0
    return
  }
  doc.ball.idleMs += dtMs
  if (doc.ball.idleMs < 1400) return
  doc.ball.vy += 140
  doc.ball.idleMs = 0
}

function beginRide(doc: PinballDocument, kind: 'ramp' | 'scoop', duration: number): void {
  doc.ball.held = kind
  doc.ball.rideMs = 0
  doc.ball.rideDur = duration
  doc.ball.vx = 0
  doc.ball.vy = 0
}

function stepRide(doc: PinballDocument, dtMs: number, sample: (progress: number) => RideSample): ContactEvent[] {
  doc.ball.rideMs += dtMs
  const progress = doc.ball.rideMs / doc.ball.rideDur
  const point = sample(Math.min(1, progress))
  doc.ball.x = point.x
  doc.ball.y = point.y
  if (progress < 1) return []
  doc.ball.held = 'none'
  doc.ball.vx = point.vx
  doc.ball.vy = point.vy
  doc.ball.rideMs = 0
  return []
}

function holeOfferNow(doc: PinballDocument): number {
  const remain = Math.min(1, Math.max(0, doc.ball.holdMs / HOLE_DECAY_MS))
  return HOLE_OFFER_MIN + (HOLE_OFFER_MAX - HOLE_OFFER_MIN) * remain
}

function kickFromHole(doc: PinballDocument): void {
  awardHole(doc, doc.ball.holeOffer)
  doc.ball.held = 'none'
  doc.ball.holdMs = 0
  doc.ball.holeLatch = false
  doc.ball.vx = HOLE_KICK_VX
  doc.ball.vy = HOLE_KICK_VY
}

function stepHole(doc: PinballDocument, dtMs: number, launchHeld: boolean): ContactEvent[] {
  doc.ball.vx = 0
  doc.ball.vy = 0
  if (!launchHeld) doc.ball.holeLatch = false
  if (launchHeld && !doc.ball.holeLatch) {
    kickFromHole(doc)
    return []
  }
  doc.ball.holdMs = Math.max(0, doc.ball.holdMs - dtMs)
  doc.ball.holeOffer = holeOfferNow(doc)
  if (doc.ball.holdMs > 0) return []
  kickFromHole(doc)
  return []
}

function capture(doc: PinballDocument, events: ContactEvent[]): void {
  for (const event of events) {
    if (doc.ball.held !== 'none') return
    if (cooled(doc, event.id)) continue
    if (event.id === BodyId.scoop && doc.ball.vy < 0) {
      beginRide(doc, 'scoop', SCOOP_MS)
      return
    }
    if (event.id === BodyId.hole) {
      doc.ball.held = 'hole'
      doc.ball.holdMs = HOLE_DECAY_MS
      doc.ball.holeOffer = HOLE_OFFER_MAX
      doc.ball.holeLatch = true
      doc.ball.x = event.x
      doc.ball.y = event.y
      doc.ball.vx = 0
      doc.ball.vy = 0
      flashNote(doc, '球进洞，按住发射踢出')
      return
    }
    if (event.id === BodyId.ramp && doc.gates.rampOpen) {
      beginRide(doc, 'ramp', RAMP_MS)
      return
    }
  }
}

function markDrainOrSeat(doc: PinballDocument): void {
  const ball = doc.ball
  if (!Number.isFinite(ball.x) || !Number.isFinite(ball.y)) {
    doc.signals.drain = true
    return
  }
  if (ball.held !== 'none') return
  if (ball.x > 358 && ball.y > 600 && ball.vy >= 0) {
    ball.held = 'plunger'
    ball.vx = 0
    ball.vy = 0
    return
  }
  const throughGap = ball.y > 704 && ball.x > 126 && ball.x < 274
  const escaped = ball.y > 748 || ball.x < -30 || ball.x > 430
  if (throughGap || escaped) {
    doc.signals.drain = true
    ball.vx = 0
    ball.vy = 0
  }
}

export function advanceBall(
  doc: PinballDocument,
  solids: Solid[],
  dtMs: number,
  rides: RideFns,
  launchHeld: boolean,
): ContactEvent[] {
  if (doc.ball.held === 'hole') return stepHole(doc, dtMs, launchHeld)
  if (doc.ball.held === 'ramp') return stepRide(doc, dtMs, rides.ramp)
  if (doc.ball.held === 'scoop') return stepRide(doc, dtMs, rides.scoop)
  if (doc.ball.held === 'plunger') return []

  const dt = Math.max(0.001, dtMs / 1000)
  const steps = Math.min(6, Math.max(1, Math.ceil((speedOf(doc.ball.vx, doc.ball.vy) * dt) / 5)))
  const slice = dt / steps
  const raw: ContactEvent[] = []
  for (let index = 0; index < steps; index += 1) {
    doc.ball.vy += 1480 * slice
    doc.ball.vx *= Math.exp(-0.18 * slice)
    doc.ball.vy *= Math.exp(-0.02 * slice)
    doc.ball.x += doc.ball.vx * slice
    doc.ball.y += doc.ball.vy * slice
    resolveBall(doc.ball, solids, raw)
    capture(doc, dedupeContacts(raw))
    if (doc.ball.held !== 'none') break
  }
  capSpeed(doc, dtMs)
  markDrainOrSeat(doc)
  return dedupeContacts(raw).filter((event) => event.id !== BodyId.scoop)
}
