import { useState, useRef, useCallback, useEffect } from 'react'
import type { CalibrationData, StoredEye, TestPoint, StimulusKey, TestResult } from '../types'
import { STIMULI } from '../types'
import { formatEyeLabel } from '../eyeLabels'
import { HeadGuide } from './HeadGuide'
import { VisualFieldMap } from './VisualFieldMap'
import { calcIsopterAreas } from '../isopterCalc'
import { Interpretation } from './Interpretation'
import { saveResult, saveSurvey, hasSurveyForResult, getDeviceId } from '../storage'
import { trackEvent } from '../api'
import { exportTrackedResultPDF } from '../pdfExportTracking'
import { ScenarioOverlay } from './ScenarioOverlay'
import { VisionSimulator } from './VisionSimulator'
import { BackButton } from './AccessibleNav'
import { PostTestSurvey } from './PostTestSurvey'
import type { SurveyResponse } from './PostTestSurvey'
import { ClinicalDisclaimer } from './ClinicalDisclaimer'
import { degToPx } from '../geometry'
import { stimulusDisplayColor } from '../stimulusDisplay'

/**
 * "Ring Test" — user-controlled expanding arc scotoma boundary mapper.
 *
 * The user expands the ring themselves (scroll/drag/arrows) while fixating.
 * They press Space/tap to mark "disappeared" and "reappeared" boundaries.
 * No reaction time component — purely boundary detection.
 *
 * The field is divided into configurable pie sectors. For each stimulus level,
 * the user sweeps each sector by expanding the arc outward. This maps
 * irregular scotomas with per-sector resolution.
 */

interface Props {
  eye: StoredEye
  calibration: CalibrationData
  extendedField?: boolean
  onDone: () => void
  onComplete?: (points: TestPoint[]) => void
}

// Expansion speed per scroll/key event in degrees
const STEP_DEG = 0.5
// Gap between sectors
const SECTOR_GAP_DEG = 4
// Sector presets
const SECTOR_PRESETS = [
  { sectors: 4,  label: 'Quick (4)',  desc: '4 quadrants — fast overview' },
  { sectors: 8,  label: 'Standard (8)', desc: '8 sectors — good balance' },
  { sectors: 12, label: 'Detailed (12)', desc: '12 sectors — more precise' },
  { sectors: 24, label: 'Precise (24)', desc: '24 sectors — fine mapping' },
]
const DEFAULT_SECTORS = 8
// Stimulus levels
const TEST_LEVELS: { key: StimulusKey; thicknessDeg: number }[] = [
  { key: 'V4e',   thicknessDeg: 1.5 },
  { key: 'III4e', thicknessDeg: 0.7 },
  { key: 'III2e', thicknessDeg: 0.5 },
  { key: 'I4e',   thicknessDeg: 0.35 },
  { key: 'I2e',   thicknessDeg: 0.25 },
]

type Phase = 'instructions' | 'active' | 'level-transition' | 'extended-transition' | 'results'

interface BoundaryEvent {
  eccentricityDeg: number
  type: 'disappear' | 'reappear'
  stimulus: StimulusKey
  sectorIdx: number
  meridianDeg: number
}

export function RingTest({ eye, calibration, extendedField, onDone, onComplete }: Props) {
  const [phase, setPhase] = useState<Phase>('instructions')
  const [numSectors, setNumSectors] = useState(DEFAULT_SECTORS)
  const [levelIdx, setLevelIdx] = useState(0)
  const [sectorIdx, setSectorIdx] = useState(0)
  const [currentEcc, setCurrentEcc] = useState(0.5) // start small, near center
  const [events, setEvents] = useState<BoundaryEvent[]>([])
  const [lastAction, setLastAction] = useState<string>('')
  const [savedId, setSavedId] = useState<string | null>(null)
  const [surveyDone, setSurveyDone] = useState(false)
  const [showVisionSim, setShowVisionSim] = useState(false)
  const [extendedLocal, setExtendedLocal] = useState(extendedField ?? false)
  const [extendedPass, setExtendedPass] = useState(0) // 0=normal, 1=fixation up (inferior), 2=fixation down (superior)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef(0)
  const eccRef = useRef(0.5)
  const levelIdxRef = useRef(0)
  const sectorIdxRef = useRef(0)
  const numSectorsRef = useRef(DEFAULT_SECTORS)
  const eventsRef = useRef<BoundaryEvent[]>([])
  const autoAdvancingRef = useRef(false)
  const touchStartY = useRef<number | null>(null)
  const hasMovedArcRef = useRef(false)
  const [hasMovedArc, setHasMovedArc] = useState(false)
  const extendedLocalRef = useRef(extendedField ?? false)
  const extendedPassRef = useRef(0)

  // Tracking-event lifecycle (start fires on first arc movement, not button click)
  const startedTrackedRef = useRef(false)
  const completedTrackedRef = useRef(false)
  const testStartedAtRef = useRef<number | null>(null)
  const getTestDurationSeconds = useCallback(() => {
    const startedAt = testStartedAtRef.current
    return startedAt == null ? undefined : Math.max(0, Math.round((Date.now() - startedAt) / 1000))
  }, [])
  const phaseRef = useRef<Phase>('instructions')
  useEffect(() => { phaseRef.current = phase }, [phase])

  useEffect(() => {
    if (phase === 'results' && startedTrackedRef.current && !completedTrackedRef.current) {
      completedTrackedRef.current = true
      const durationSeconds = getTestDurationSeconds()
      trackEvent('test_completed', getDeviceId(), {
        testType: 'ring', eye,
        events: String(eventsRef.current.length),
        ...(durationSeconds != null ? { durationSeconds: String(durationSeconds) } : {}),
      }).catch(() => {})
    }
  }, [phase, eye, getTestDurationSeconds])

  useEffect(() => {
    return () => {
      if (startedTrackedRef.current && !completedTrackedRef.current) {
        const durationSeconds = getTestDurationSeconds()
        trackEvent('test_aborted', getDeviceId(), {
          testType: 'ring', eye, phase: phaseRef.current,
          events: String(eventsRef.current.length),
          ...(durationSeconds != null ? { durationSeconds: String(durationSeconds) } : {}),
        }).catch(() => {})
      }
    }
  }, [eye, getTestDurationSeconds])

  const fixOffsetX = calibration.fixationOffsetPx
  const maxEcc = calibration.maxEccentricityDeg

  const fixX = typeof window !== 'undefined' ? window.innerWidth / 2 + fixOffsetX : 500
  // fixY shifts for extended passes: up for inferior field, down for superior field
  const fixY = (() => {
    const h = typeof window !== 'undefined' ? window.innerHeight : 800
    if (extendedPass === 1) return Math.round(h * 0.2)  // shifted up → more inferior coverage
    if (extendedPass === 2) return Math.round(h * 0.8)  // shifted down → more superior coverage
    return Math.round(h / 2)
  })()

  const currentLevel = TEST_LEVELS[levelIdx]
  const totalSweeps = TEST_LEVELS.length * numSectors
  const currentSweep = levelIdx * numSectors + sectorIdx + 1

  // ---- Drawing ----
  const draw = useCallback((ecc: number, level: typeof TEST_LEVELS[0], sector: number) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Ensure canvas buffer matches screen (handles DPR + first draw after mount)
    const dpr = window.devicePixelRatio || 1
    const w = window.innerWidth
    const h = window.innerHeight
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr
      canvas.height = h * dpr
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, w, h)

    const stimDef = STIMULI[level.key]
    // Ensure minimum visible thickness (at least 3px outer radius)
    const rInner = degToPx(Math.max(0, ecc - level.thicknessDeg / 2), calibration)
    const rOuter = Math.max(rInner + 3, degToPx(ecc + level.thicknessDeg / 2, calibration))

    const sWidth = 360 / numSectorsRef.current
    const sectorCenterDeg = sector * sWidth
    const halfArc = (sWidth - SECTOR_GAP_DEG) / 2
    const startAngle = -(sectorCenterDeg + halfArc) * Math.PI / 180
    const endAngle = -(sectorCenterDeg - halfArc) * Math.PI / 180

    // Draw the arc — always white (achromatic presentation); intensity controlled by globalAlpha
    ctx.beginPath()
    ctx.arc(fixX, fixY, rOuter, startAngle, endAngle, false)
    ctx.arc(fixX, fixY, rInner, endAngle, startAngle, true)
    ctx.closePath()

    ctx.fillStyle = stimulusDisplayColor(level.key)
    ctx.globalAlpha = Math.max(0.25, stimDef.intensityFrac)
    ctx.fill()
    ctx.globalAlpha = 1

    // Sector guides — show center line for each sector, highlight active one
    // Dim the active guide to match stimulus intensity so it doesn't distort dim-arc tests
    const nSectors = numSectorsRef.current
    const stimIntensity = stimDef.intensityFrac
    for (let s = 0; s < nSectors; s++) {
      const sCenterDeg = s * sWidth
      const lineAngle = -sCenterDeg * Math.PI / 180
      const isActive = s === sector
      const lineLen = degToPx(maxEcc, calibration) * (isActive ? 0.6 : 0.3)
      ctx.strokeStyle = isActive ? '#4ade80' : '#1a1a2e'
      ctx.lineWidth = isActive ? 1.5 : 0.5
      // Scale active guide opacity with stimulus intensity to avoid distortion
      ctx.globalAlpha = isActive ? Math.min(0.6, 0.15 + stimIntensity * 0.45) : 1
      ctx.beginPath()
      ctx.moveTo(fixX, fixY)
      ctx.lineTo(fixX + Math.cos(lineAngle) * lineLen, fixY + Math.sin(lineAngle) * lineLen)
      ctx.stroke()
      ctx.globalAlpha = 1
    }

    // Show existing boundary marks for this sector+level
    const stim = TEST_LEVELS[levelIdxRef.current].key
    const sectorEvents = eventsRef.current.filter(
      ev => ev.stimulus === stim && ev.sectorIdx === sector,
    )
    for (const ev of sectorEvents) {
      const markR = degToPx(ev.eccentricityDeg, calibration)
      const markAngle = -sectorCenterDeg * Math.PI / 180
      const mx = fixX + Math.cos(markAngle) * markR
      const my = fixY + Math.sin(markAngle) * markR
      ctx.beginPath()
      ctx.arc(mx, my, 4, 0, Math.PI * 2)
      ctx.fillStyle = ev.type === 'disappear' ? '#ef4444' : '#22c55e'
      ctx.fill()
    }

    // Fixation cross — color indicates mode:
    // Green = visible (expecting "disappear" mark), Red = not visible (expecting "reappear" mark)
    const sectorEvts = eventsRef.current.filter(ev => ev.stimulus === stim && ev.sectorIdx === sector)
    const isDisappearNext = sectorEvts.length % 2 === 0
    const fixColor = isDisappearNext ? '#4ade80' : '#ef4444' // green = visible, red = gone

    ctx.strokeStyle = fixColor
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(fixX - 10, fixY)
    ctx.lineTo(fixX + 10, fixY)
    ctx.moveTo(fixX, fixY - 10)
    ctx.lineTo(fixX, fixY + 10)
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(fixX, fixY, 3, 0, Math.PI * 2)
    ctx.fillStyle = fixColor
    ctx.fill()

    // Eccentricity indicator
    ctx.fillStyle = '#64748b'
    ctx.font = '11px monospace'
    ctx.textAlign = 'right'
    ctx.fillText(`${ecc.toFixed(1)}°`, fixX - 16, fixY - 16)
  }, [fixX, fixY, calibration, maxEcc])

  // ---- Redraw on eccentricity change ----
  useEffect(() => {
    if (phase === 'active') {
      draw(currentEcc, TEST_LEVELS[levelIdx], sectorIdx)
    }
  }, [phase, currentEcc, levelIdx, sectorIdx, draw])

  // ---- Advance to next sector ----
  const nextSector = useCallback(() => {
    const next = sectorIdxRef.current + 1
    const isExtended = extendedPassRef.current > 0
    const maxLevels = isExtended ? 1 : TEST_LEVELS.length // Extended passes: V4e only
    if (next >= numSectorsRef.current) {
      // Level complete
      const nextLevel = levelIdxRef.current + 1
      if (nextLevel >= maxLevels) {
        // All levels for this pass done
        if (extendedLocalRef.current && extendedPassRef.current === 0) {
          // Start extended pass 1 (inferior — fixation up)
          extendedPassRef.current = 1
          setExtendedPass(1)
          levelIdxRef.current = 0
          setLevelIdx(0)
          sectorIdxRef.current = 0
          setSectorIdx(0)
          eccRef.current = 0.5
          setCurrentEcc(0.5)
          autoAdvancingRef.current = false
          setPhase('extended-transition')
          return
        }
        if (extendedLocalRef.current && extendedPassRef.current === 1) {
          // Start extended pass 2 (superior — fixation down)
          extendedPassRef.current = 2
          setExtendedPass(2)
          levelIdxRef.current = 0
          setLevelIdx(0)
          sectorIdxRef.current = 0
          setSectorIdx(0)
          eccRef.current = 0.5
          setCurrentEcc(0.5)
          autoAdvancingRef.current = false
          setPhase('extended-transition')
          return
        }
        setPhase('results')
        return
      }
      levelIdxRef.current = nextLevel
      setLevelIdx(nextLevel)
      sectorIdxRef.current = 0
      setSectorIdx(0)
      eccRef.current = 0.5
      setCurrentEcc(0.5)
      autoAdvancingRef.current = false
      setPhase('level-transition')
      return
    }
    sectorIdxRef.current = next
    setSectorIdx(next)
    eccRef.current = 0.5
    setCurrentEcc(0.5)
    setLastAction('')
    autoAdvancingRef.current = false
  }, [])

  // ---- Go back to previous sector ----
  const prevSector = useCallback(() => {
    if (sectorIdxRef.current > 0) {
      const prev = sectorIdxRef.current - 1
      sectorIdxRef.current = prev
      setSectorIdx(prev)
      eccRef.current = 0.5
      setCurrentEcc(0.5)
      setLastAction(`Back to sector ${prev + 1}`)
      autoAdvancingRef.current = false
    } else if (levelIdxRef.current > 0) {
      // Go back to last sector of previous level
      const prevLevel = levelIdxRef.current - 1
      levelIdxRef.current = prevLevel
      setLevelIdx(prevLevel)
      const lastSector = numSectorsRef.current - 1
      sectorIdxRef.current = lastSector
      setSectorIdx(lastSector)
      eccRef.current = 0.5
      setCurrentEcc(0.5)
      setLastAction(`Back to ${TEST_LEVELS[prevLevel].key} sector ${lastSector + 1}`)
      autoAdvancingRef.current = false
    }
  }, [])

  // ---- Max eccentricity for current sector (actual screen edge) ----
  const getMaxEccForSector = useCallback((sectorIndex: number): number => {
    const w = typeof window !== 'undefined' ? window.innerWidth : 1000
    const h = typeof window !== 'undefined' ? window.innerHeight : 800
    const fx = w / 2 + fixOffsetX
    const fy = fixY

    const sWidth = 360 / numSectorsRef.current
    const sectorCenterDeg = sectorIndex * sWidth
    // Canvas uses negated angles (clockwise from right)
    const angle = -sectorCenterDeg * Math.PI / 180
    const cosA = Math.cos(angle)
    const sinA = Math.sin(angle)

    // Distance from fixation to screen edge along this sector's direction
    let maxDist = Infinity
    if (cosA > 0.01) maxDist = Math.min(maxDist, (w - fx) / cosA)
    if (cosA < -0.01) maxDist = Math.min(maxDist, -fx / cosA)
    if (sinA > 0.01) maxDist = Math.min(maxDist, (h - fy) / sinA)
    if (sinA < -0.01) maxDist = Math.min(maxDist, -fy / sinA)

    // Convert pixels to degrees, add small margin so arc just touches edge
    return Math.max(5, maxDist / calibration.pixelsPerDegree - 0.5)
  }, [fixOffsetX, calibration, fixY])

  // ---- Expand/contract ring ----
  const adjustEcc = useCallback((delta: number) => {
    if (phase !== 'active') return
    // Hide positioning guide on first arc movement
    if (!hasMovedArcRef.current) {
      hasMovedArcRef.current = true
      setHasMovedArc(true)
    }
    if (!startedTrackedRef.current) {
      startedTrackedRef.current = true
      testStartedAtRef.current = Date.now()
      trackEvent('test_started', getDeviceId(), { testType: 'ring', eye }).catch(() => {})
    }
    const maxReach = getMaxEccForSector(sectorIdxRef.current)
    eccRef.current = Math.max(0.5, Math.min(maxReach, eccRef.current + delta))
    setCurrentEcc(eccRef.current)

    // Auto-advance when reaching the screen edge
    if (eccRef.current >= maxReach && !autoAdvancingRef.current) {
      autoAdvancingRef.current = true
      setTimeout(() => nextSector(), 400)
    }
  }, [phase, getMaxEccForSector, nextSector, eye])

  // ---- Record boundary event ----
  const recordEvent = useCallback((type: 'disappear' | 'reappear') => {
    if (phase !== 'active') return
    const ecc = eccRef.current
    const stim = TEST_LEVELS[levelIdxRef.current].key
    const sector = sectorIdxRef.current
    const meridian = sector * (360 / numSectorsRef.current)
    const event: BoundaryEvent = {
      eccentricityDeg: ecc, type, stimulus: stim,
      sectorIdx: sector, meridianDeg: meridian,
    }
    eventsRef.current = [...eventsRef.current, event]
    setEvents(eventsRef.current)
    if (type === 'disappear') {
      setLastAction(`Gone at ${ecc.toFixed(1)}° — keep expanding to find where it returns`)
    } else {
      setLastAction(`Back at ${ecc.toFixed(1)}° — keep expanding or press Enter to advance`)
    }
  }, [phase])

  // ---- Undo last event for current sector/stimulus ----
  const undoLastEvent = useCallback(() => {
    if (phase !== 'active') return
    const stim = TEST_LEVELS[levelIdxRef.current].key
    const sector = sectorIdxRef.current
    // Find last event for this sector/stimulus and remove it
    let idx = -1
    for (let i = eventsRef.current.length - 1; i >= 0; i--) {
      if (eventsRef.current[i].stimulus === stim && eventsRef.current[i].sectorIdx === sector) {
        idx = i
        break
      }
    }
    if (idx >= 0) {
      const removed = eventsRef.current[idx]
      eventsRef.current = eventsRef.current.filter((_, i) => i !== idx)
      setEvents(eventsRef.current)
      setLastAction(`Undid ${removed.type} at ${removed.eccentricityDeg.toFixed(1)}°`)
    } else {
      setLastAction('Nothing to undo')
    }
  }, [phase])

  // ---- Keyboard: arrows = expand/contract, space = mark, enter = next sector ----
  useEffect(() => {
    if (phase === 'instructions') {
      // Arrow keys for sector preset selection
      const handler = (e: KeyboardEvent) => {
        const presetValues = SECTOR_PRESETS.map(p => p.sectors)
        const idx = presetValues.indexOf(numSectorsRef.current)
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
          e.preventDefault()
          const next = Math.min(idx + 1, presetValues.length - 1)
          setNumSectors(presetValues[next])
          numSectorsRef.current = presetValues[next]
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
          e.preventDefault()
          const prev = Math.max(idx - 1, 0)
          setNumSectors(presetValues[prev])
          numSectorsRef.current = presetValues[prev]
        }
      }
      window.addEventListener('keydown', handler)
      return () => window.removeEventListener('keydown', handler)
    }

    if (phase !== 'active') return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
        e.preventDefault()
        adjustEcc(STEP_DEG)
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
        e.preventDefault()
        adjustEcc(-STEP_DEG)
      } else if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault()
        const stim = TEST_LEVELS[levelIdxRef.current].key
        const sector = sectorIdxRef.current
        const evts = eventsRef.current.filter(ev => ev.stimulus === stim && ev.sectorIdx === sector)
        const nextType = evts.length % 2 === 0 ? 'disappear' : 'reappear'
        recordEvent(nextType)
      } else if (e.key === 'Backspace' || e.key === 'Delete' || e.key === 'Control') {
        e.preventDefault()
        undoLastEvent()
      } else if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault()
        prevSector()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        nextSector()
      } else if (e.key === 'Escape') {
        onDone()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [phase, adjustEcc, recordEvent, undoLastEvent, nextSector, prevSector, onDone])

  // ---- Mouse wheel: expand/contract ----
  useEffect(() => {
    if (phase !== 'active') return
    const handler = (e: WheelEvent) => {
      e.preventDefault()
      adjustEcc(e.deltaY < 0 ? STEP_DEG : -STEP_DEG)
    }
    window.addEventListener('wheel', handler, { passive: false })
    return () => window.removeEventListener('wheel', handler)
  }, [phase, adjustEcc])

  // ---- Mouse clicks: left=mark, right=undo, middle=next sector ----
  useEffect(() => {
    if (phase !== 'active') return
    const handler = (e: MouseEvent) => {
      if (e.button === 0) {
        // Left click — mark disappear/reappear
        e.preventDefault()
        const stim = TEST_LEVELS[levelIdxRef.current].key
        const sector = sectorIdxRef.current
        const evts = eventsRef.current.filter(ev => ev.stimulus === stim && ev.sectorIdx === sector)
        const nextType = evts.length % 2 === 0 ? 'disappear' : 'reappear'
        recordEvent(nextType)
      } else if (e.button === 2) {
        // Right click — undo last event
        e.preventDefault()
        undoLastEvent()
      } else if (e.button === 1) {
        // Middle click (scroll wheel press) — advance/go back
        e.preventDefault()
        if (e.shiftKey) {
          prevSector()
        } else {
          nextSector()
        }
      }
    }
    // Prevent context menu on right-click during test
    const preventContext = (e: MouseEvent) => { e.preventDefault() }
    window.addEventListener('mousedown', handler)
    window.addEventListener('contextmenu', preventContext)
    return () => {
      window.removeEventListener('mousedown', handler)
      window.removeEventListener('contextmenu', preventContext)
    }
  }, [phase, recordEvent, undoLastEvent, nextSector, prevSector])

  // ---- Touch: drag up/down = expand/contract, tap = mark ----
  useEffect(() => {
    if (phase !== 'active') return
    const onStart = (e: TouchEvent) => {
      touchStartY.current = e.touches[0].clientY
    }
    const onMove = (e: TouchEvent) => {
      e.preventDefault()
      if (touchStartY.current == null) return
      const dy = touchStartY.current - e.touches[0].clientY
      if (Math.abs(dy) > 3) {
        adjustEcc(dy * 0.05)
        touchStartY.current = e.touches[0].clientY
      }
    }
    const onEnd = (e: TouchEvent) => {
      // If barely moved, treat as tap → mark boundary
      if (touchStartY.current != null) {
        const moved = e.changedTouches[0] ? Math.abs(touchStartY.current - e.changedTouches[0].clientY) : 999
        if (moved < 10) {
          const stim = TEST_LEVELS[levelIdxRef.current].key
          const sector = sectorIdxRef.current
          const evts = eventsRef.current.filter(ev => ev.stimulus === stim && ev.sectorIdx === sector)
          const nextType = evts.length % 2 === 0 ? 'disappear' : 'reappear'
          recordEvent(nextType)
        }
      }
      touchStartY.current = null
    }
    window.addEventListener('touchstart', onStart, { passive: false })
    window.addEventListener('touchmove', onMove, { passive: false })
    window.addEventListener('touchend', onEnd)
    return () => {
      window.removeEventListener('touchstart', onStart)
      window.removeEventListener('touchmove', onMove)
      window.removeEventListener('touchend', onEnd)
    }
  }, [phase, adjustEcc, recordEvent])

  // Cleanup
  useEffect(() => {
    return () => {
      // The latest RAF id is intentionally read during unmount.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  // Redraw on window resize
  useEffect(() => {
    if (phase !== 'active') return
    const onResize = () => draw(eccRef.current, TEST_LEVELS[levelIdxRef.current], sectorIdxRef.current)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [phase, draw])

  // ---- Convert events to TestPoints ----
  const buildTestPoints = useCallback((): TestPoint[] => {
    const points: TestPoint[] = []
    const allEvents = eventsRef.current
    const nSectors = numSectorsRef.current
    const sWidth = 360 / nSectors

    for (const level of TEST_LEVELS) {
      for (let s = 0; s < nSectors; s++) {
        const meridianDeg = s * sWidth
        const sectorEvents = allEvents.filter(e => e.stimulus === level.key && e.sectorIdx === s)

        if (sectorEvents.length === 0) {
          // No clicks — visible all the way to edge
          points.push({ meridianDeg, eccentricityDeg: maxEcc, rawEccentricityDeg: maxEcc, detected: true, stimulus: level.key })
          continue
        }

        // Process events in chronological order (disappear/reappear pairs).
        // Each disappear marks where vision is lost, each reappear marks where it returns.
        // After the last reappear, the field extends visibly to the screen edge.
        const disappears = sectorEvents.filter(e => e.type === 'disappear')
        const reappears = sectorEvents.filter(e => e.type === 'reappear')

        if (disappears.length === 0) {
          // Only reappear events (shouldn't happen normally) — treat as visible to edge
          points.push({ meridianDeg, eccentricityDeg: maxEcc, rawEccentricityDeg: maxEcc, detected: true, stimulus: level.key })
          continue
        }

        // Mark visible up to first disappear
        points.push({ meridianDeg, eccentricityDeg: disappears[0].eccentricityDeg, rawEccentricityDeg: disappears[0].eccentricityDeg, detected: true, stimulus: level.key })

        for (let i = 0; i < disappears.length; i++) {
          const dis = disappears[i]
          const reap = reappears[i] // may be undefined for the last disappear

          if (reap) {
            // Ring scotoma: scotoma between disappear and reappear
            const midEcc = (dis.eccentricityDeg + reap.eccentricityDeg) / 2
            points.push({ meridianDeg, eccentricityDeg: midEcc, rawEccentricityDeg: midEcc, detected: false, stimulus: level.key })
            points.push({ meridianDeg, eccentricityDeg: reap.eccentricityDeg, rawEccentricityDeg: reap.eccentricityDeg, detected: true, stimulus: level.key })
          } else {
            // Last disappear without reappear — scotoma extends to edge
            points.push({ meridianDeg, eccentricityDeg: dis.eccentricityDeg + 10, rawEccentricityDeg: dis.eccentricityDeg + 10, detected: false, stimulus: level.key })
          }
        }

        // If the last event was a reappear, the field is visible from there to the edge.
        // Add an outer boundary point so the isopter extends to the screen edge.
        if (reappears.length >= disappears.length) {
          const sectorMaxEcc = getMaxEccForSector(s)
          points.push({ meridianDeg, eccentricityDeg: sectorMaxEcc, rawEccentricityDeg: sectorMaxEcc, detected: true, stimulus: level.key })
        }
      }
    }
    return points
  }, [maxEcc, getMaxEccForSector])

  const handleFinish = useCallback(() => {
    const pts = buildTestPoints()
    if (onComplete) { onComplete(pts) } else { onDone() }
  }, [buildTestPoints, onComplete, onDone])

  // ---- Instructions ----
  if (phase === 'instructions') {
    return (
      <div className="min-h-screen bg-gray-950 text-white flex items-center justify-center p-6">
        <main className="max-w-sm w-full space-y-8 text-center">
          <div className="w-20 h-20 mx-auto rounded-full bg-blue-600/20 flex items-center justify-center">
            <svg viewBox="0 0 24 24" className="w-10 h-10 text-blue-400" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
              <circle cx="12" cy="12" r="10" />
              <circle cx="12" cy="12" r="6" strokeDasharray="3,3" />
              <circle cx="12" cy="12" r="2" fill="currentColor" />
            </svg>
          </div>

          <div className="space-y-2">
            <h1 className="text-2xl font-semibold">Ring Test</h1>
            <p className="text-gray-400 text-sm">You control the ring — no time pressure</p>
          </div>

          <div className="bg-gray-900 rounded-xl p-5 space-y-4 text-sm text-left">
            <p className="text-gray-300">
              Expand a ring outward from the center while keeping your eye on the yellow cross.
            </p>
            <div className="space-y-3">
              <div className="flex gap-2 items-start">
                <span className="text-blue-400 mt-0.5 font-bold">1.</span>
                <p className="text-gray-300">
                  <strong>Scroll</strong>, <strong>drag</strong>, or use <kbd className="px-1 py-0.5 bg-gray-800 rounded text-xs">↑↓</kbd> to expand/shrink the ring
                </p>
              </div>
              <div className="flex gap-2 items-start">
                <span className="text-blue-400 mt-0.5 font-bold">2.</span>
                <p className="text-gray-300">
                  <strong>Left click</strong> or <kbd className="px-1.5 py-0.5 bg-gray-800 rounded text-xs">Space</kbd> when the ring
                  <span className="text-red-400 font-medium"> disappears</span>, then again when it
                  <span className="text-green-400 font-medium"> reappears</span>
                </p>
              </div>
              <div className="flex gap-2 items-start">
                <span className="text-blue-400 mt-0.5 font-bold">3.</span>
                <p className="text-gray-300">
                  <strong>Middle click</strong> or <kbd className="px-1.5 py-0.5 bg-gray-800 rounded text-xs">Enter</kbd> to advance to next sector
                </p>
              </div>
              <div className="flex gap-2 items-start">
                <span className="text-gray-500 mt-0.5 font-bold">◀</span>
                <p className="text-gray-400 text-xs">
                  <strong>Shift+Middle click</strong> or <kbd className="px-1 py-0.5 bg-gray-800 rounded text-xs">Shift+Enter</kbd> to go back a sector
                </p>
              </div>
              <div className="flex gap-2 items-start">
                <span className="text-gray-500 mt-0.5 font-bold">↩</span>
                <p className="text-gray-400 text-xs">
                  <strong>Right click</strong> or <kbd className="px-1 py-0.5 bg-gray-800 rounded text-xs">Backspace</kbd> to undo last mark
                </p>
              </div>
            </div>
            <div className="pt-2 border-t border-gray-800 flex items-center justify-between">
              <span className="text-gray-500 text-xs">{totalSweeps} sectors total</span>
              <span className="text-gray-500 text-xs">Go at your own pace</span>
            </div>
          </div>

          <HeadGuide eye={eye} viewingDistanceCm={calibration.viewingDistanceCm} />

          {/* Sector precision */}
          <div className="space-y-3">
            <p className="text-xs text-gray-500">Scotoma detail level</p>
            <div className="grid grid-cols-4 gap-2">
              {SECTOR_PRESETS.map(preset => (
                <button
                  key={preset.sectors}
                  onClick={() => { setNumSectors(preset.sectors); numSectorsRef.current = preset.sectors }}
                  className={`py-2 px-1 rounded-lg text-xs font-medium transition-colors border ${
                    numSectors === preset.sectors
                      ? 'bg-blue-600 border-blue-500 text-white'
                      : 'bg-gray-900 border-gray-800 text-gray-400 hover:border-gray-600'
                  }`}
                >
                  <span className="block text-lg">{preset.sectors}</span>
                  <span className="block text-xs opacity-70">sectors</span>
                </button>
              ))}
            </div>
            <p className="text-xs text-gray-600 text-center">
              {SECTOR_PRESETS.find(p => p.sectors === numSectors)?.desc}
            </p>
          </div>

          {/* Preview */}
          <div className="flex justify-center">
            <svg viewBox="0 0 120 120" width={120} height={120} aria-hidden="true">
              {Array.from({ length: numSectors }, (_, i) => {
                const sw = 360 / numSectors
                const startA = -(i * sw + (sw - SECTOR_GAP_DEG) / 2) * Math.PI / 180
                const endA = -(i * sw - (sw - SECTOR_GAP_DEG) / 2) * Math.PI / 180
                const r = 50; const cx = 60; const cy = 60
                const largeArc = sw - SECTOR_GAP_DEG > 180 ? 1 : 0
                return (
                  <path key={i}
                    d={`M ${cx} ${cy} L ${cx + Math.cos(startA) * r} ${cy + Math.sin(startA) * r} A ${r} ${r} 0 ${largeArc} 1 ${cx + Math.cos(endA) * r} ${cy + Math.sin(endA) * r} Z`}
                    fill={i === 0 ? '#3b82f6' : '#1e293b'} fillOpacity={i === 0 ? 0.4 : 0.3}
                    stroke="#334155" strokeWidth={0.5}
                  />
                )
              })}
              <circle cx={60} cy={60} r={2} fill="#fbbf24" />
            </svg>
          </div>

          {/* Field coverage diagram + extended toggle */}
          {(() => {
            const screenW = typeof screen !== 'undefined' ? screen.width : (typeof window !== 'undefined' ? window.innerWidth : 1440)
            const screenH = typeof screen !== 'undefined' ? screen.height : (typeof window !== 'undefined' ? window.innerHeight : 900)
            const diagramMaxDeg = 100
            const dScale = 120 / diagramMaxDeg // 120 SVG units = 100 degrees

            // Normal monocular visual field (elliptical interpolation)
            const monocularPts = Array.from({ length: 36 }, (_, i) => {
              const angleDeg = i * 10
              const rad = (angleDeg * Math.PI) / 180
              const cos = Math.cos(rad)
              const sin = Math.sin(rad) // positive = superior
              const tExt = eye === 'right' ? 90 : 60
              const nExt = eye === 'right' ? 60 : 90
              const hExt = cos >= 0 ? tExt : nExt
              const vExt = sin >= 0 ? 60 : 70 // S=60, I=70
              const extent = Math.abs(cos) < 0.001 ? vExt : Math.abs(sin) < 0.001 ? hExt
                : 1 / Math.sqrt((cos / hExt) ** 2 + (sin / vExt) ** 2)
              const r = Math.min(extent * dScale, 135)
              return `${150 + r * cos},${150 - r * sin}`
            }).join(' ')

            // Screen testable area for a given vertical offset
            const screenPoly = (fyOffset: number) => Array.from({ length: 36 }, (_, i) => {
              const angleDeg = i * 10
              const rad = (angleDeg * Math.PI) / 180
              const dx = Math.cos(rad)
              const dy = -Math.sin(rad) // positive = down in screen coords
              const halfW = screenW / 2
              const halfH = screenH / 2
              const fx = fixOffsetX
              let t = 9999
              if (dx > 0.001) t = Math.min(t, (halfW - fx) / dx)
              if (dx < -0.001) t = Math.min(t, (-halfW - fx) / dx)
              if (dy > 0.001) t = Math.min(t, (halfH - fyOffset) / dy)
              if (dy < -0.001) t = Math.min(t, (-halfH - fyOffset) / dy)
              const eccDeg = t / calibration.pixelsPerDegree
              const r = Math.min(eccDeg * dScale, 135)
              return { deg: eccDeg, pt: `${150 + r * Math.cos(rad)},${150 - r * Math.sin(rad)}` }
            })

            const normalPoly = screenPoly(0)
            const normalPts = normalPoly.map(p => p.pt).join(' ')

            // Extended: union of normal + shifted up + shifted down
            const upShift = -screenH * 0.3 // fixation 30% above center
            const downShift = screenH * 0.3
            const upPoly = screenPoly(upShift)
            const downPoly = screenPoly(downShift)
            const extendedPts = Array.from({ length: 36 }, (_, i) => {
              const maxDeg = Math.max(normalPoly[i].deg, upPoly[i].deg, downPoly[i].deg)
              const r = Math.min(maxDeg * dScale, 135)
              const rad = (i * 10 * Math.PI) / 180
              return `${150 + r * Math.cos(rad)},${150 - r * Math.sin(rad)}`
            }).join(' ')

            return (
              <div className="bg-gray-900/50 rounded-xl p-4 text-center space-y-3">
                <p className="text-xs text-gray-500 font-medium">Field coverage</p>
                <svg viewBox="0 0 300 300" className="mx-auto w-full" style={{ maxWidth: 260 }} aria-hidden="true">
                  {/* Reference rings */}
                  {[10, 20, 30, 40, 50, 60, 70, 80, 90].map(deg => {
                    const r = deg * dScale
                    return (
                      <g key={deg}>
                        <circle cx={150} cy={150} r={r} fill="none" stroke="#1e293b" strokeWidth={0.5} />
                        {deg % 30 === 0 && (
                          <text x={150 + r + 3} y={147} fill="#475569" fontSize={8}>{deg}°</text>
                        )}
                      </g>
                    )
                  })}
                  {/* RP-relevant zone: 20° = legal blindness threshold */}
                  <circle cx={150} cy={150} r={20 * dScale} fill="none" stroke="#f59e0b" strokeWidth={1} strokeDasharray="2,3" strokeOpacity={0.5} />
                  {/* Normal monocular field (gray dashed) */}
                  <polygon points={monocularPts} fill="none" stroke="#475569" strokeWidth={1} strokeDasharray="4,3" strokeOpacity={0.7} />
                  {/* Extended testable area (green, behind blue) */}
                  {extendedLocal && (
                    <polygon points={extendedPts} fill="#22c55e" fillOpacity={0.08} stroke="#22c55e" strokeWidth={1} strokeOpacity={0.5} strokeDasharray="3,2" />
                  )}
                  {/* Screen-testable area (blue) */}
                  <polygon points={normalPts} fill="#3b82f6" fillOpacity={0.15} stroke="#3b82f6" strokeWidth={1.5} strokeOpacity={0.7} />
                  {/* Fixation point */}
                  <circle cx={150} cy={150} r={3} fill="#fbbf24" />
                  {/* Labels */}
                  <text x={288} y={155} fill="#94a3b8" fontSize={11} textAnchor="end">{eye === 'right' ? 'T' : 'N'}</text>
                  <text x={12} y={155} fill="#94a3b8" fontSize={11}>{eye === 'right' ? 'N' : 'T'}</text>
                  <text x={150} y={16} fill="#94a3b8" fontSize={11} textAnchor="middle">S</text>
                  <text x={150} y={296} fill="#94a3b8" fontSize={11} textAnchor="middle">I</text>
                </svg>
                <div className="flex gap-3 justify-center flex-wrap text-xs text-gray-500">
                  <span className="flex items-center gap-1">
                    <span className="inline-block w-3 h-0 border-t border-dashed" style={{ borderColor: '#475569' }} /> normal field
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="inline-block w-3 h-0 border-t" style={{ borderColor: '#3b82f6' }} /> testable
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="inline-block w-3 h-0 border-t border-dashed" style={{ borderColor: '#f59e0b' }} /> 20° RP
                  </span>
                  {extendedLocal && (
                    <span className="flex items-center gap-1">
                      <span className="inline-block w-3 h-0 border-t border-dashed" style={{ borderColor: '#22c55e' }} /> extended
                    </span>
                  )}
                </div>

                {/* Extended field toggle */}
                <button
                  onClick={() => { setExtendedLocal(v => { extendedLocalRef.current = !v; return !v }) }}
                  className={`w-full text-left px-4 py-3 rounded-xl border transition-colors mt-2 ${
                    extendedLocal
                      ? 'bg-green-600/10 border-green-500/50'
                      : 'bg-gray-900 border-gray-700/50 hover:border-gray-600'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-medium text-xs text-gray-300">Extended field mode</p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        2 extra V4e passes with shifted fixation for more vertical coverage (~2 min extra)
                      </p>
                    </div>
                    <div className={`w-9 h-5 rounded-full flex items-center px-0.5 transition-colors flex-shrink-0 ml-2 ${
                      extendedLocal ? 'bg-green-600 justify-end' : 'bg-gray-700 justify-start'
                    }`}>
                      <div className="w-4 h-4 rounded-full bg-white" />
                    </div>
                  </div>
                </button>
              </div>
            )
          })()}

          <button
            onClick={() => { numSectorsRef.current = numSectors; eccRef.current = 0.5; setCurrentEcc(0.5); setPhase('active') }}
            className="w-full py-3 btn-primary rounded-xl text-lg font-medium text-white"
          >
            Start ring test
          </button>
          <BackButton onClick={onDone} />
        </main>
      </div>
    )
  }

  // ---- Level transition ----
  if (phase === 'level-transition') {
    const nextLevel = TEST_LEVELS[levelIdx]
    return (
      <div className="min-h-screen bg-black text-white relative">
        <div
          className="absolute text-center space-y-4 max-w-xs"
          style={{
            left: fixX,
            top: fixY,
            transform: 'translate(-50%, -50%)',
          }}
        >
          <p className="text-gray-400 text-sm" aria-live="polite">Level {levelIdx + 1} of {TEST_LEVELS.length}</p>
          <p className="text-white">
            Next: <span className="font-semibold" style={{ color: STIMULI[nextLevel.key].color }}>{nextLevel.key}</span>
          </p>
          <p className="text-gray-500 text-xs">
            {STIMULI[nextLevel.key].intensityFrac < 0.5 ? 'Dimmer' : 'Bright'}
            {nextLevel.thicknessDeg < 0.5 ? ', thinner arc' : ' arc'}
          </p>
          <button onClick={() => { eccRef.current = 0.5; setCurrentEcc(0.5); setPhase('active') }}
            className="px-8 py-3 btn-primary rounded-xl font-medium text-white">
            Continue
          </button>
        </div>
      </div>
    )
  }

  // ---- Extended transition ----
  if (phase === 'extended-transition') {
    const passLabel = extendedPass === 1
      ? 'Inferior field — fixation moves up'
      : 'Superior field — fixation moves down'
    const passDesc = extendedPass === 1
      ? 'Look at the fixation cross near the top of the screen. This tests your inferior (lower) peripheral field further.'
      : 'Look at the fixation cross near the bottom of the screen. This tests your superior (upper) peripheral field further.'
    return (
      <div className="min-h-screen bg-black text-white relative">
        <div
          className="absolute text-center space-y-4 max-w-xs"
          style={{ left: fixX, top: typeof window !== 'undefined' ? window.innerHeight / 2 : 400, transform: 'translate(-50%, -50%)' }}
        >
          <p className="text-gray-400 text-sm" aria-live="polite">Extended pass {extendedPass} of 2</p>
          <p className="text-white font-semibold">{passLabel}</p>
          <p className="text-gray-500 text-xs">{passDesc}</p>
          <p className="text-gray-500 text-xs">V4e only — {numSectors} sectors</p>
          <button
            onClick={() => { eccRef.current = 0.5; setCurrentEcc(0.5); hasMovedArcRef.current = false; setHasMovedArc(false); setPhase('active') }}
            className="px-8 py-3 btn-primary rounded-xl font-medium text-white"
          >
            Continue
          </button>
        </div>
      </div>
    )
  }

  // ---- Results ----
  if (phase === 'results') {
    const pts = buildTestPoints()
    const areas = calcIsopterAreas(pts)
    const mapSize = Math.min(500, typeof window !== 'undefined' ? window.innerWidth - 48 : 500)

	    if (!savedId && pts.length > 0) {
	      const result: TestResult = {
	        id: crypto.randomUUID(), eye, date: new Date().toISOString(),
	        points: pts, isopterAreas: areas, calibration, testType: 'ring',
	        durationSeconds: getTestDurationSeconds(),
	      }
      saveResult(result)
      setSavedId(result.id)
    }

    return (
      <div className="min-h-screen bg-gray-950 text-white p-6 overflow-y-auto">
        <main className="max-w-lg mx-auto space-y-6 pb-12">
          <h1 className="text-2xl font-semibold text-center">Ring Test Results</h1>
          <p className="text-center text-xs text-gray-500">Ring scotoma boundary test · {formatEyeLabel(eye)}</p>
          {savedId && (
            <p className="text-center text-green-400 text-xs">
              Saved automatically — this result is now available on the Results page.
            </p>
          )}
          <VisualFieldMap points={pts} eye={eye}
            maxEccentricity={maxEcc} size={mapSize} calibration={calibration} enableVerify />
          <div className="space-y-2">
            <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider px-1">Boundary map per stimulus</h3>
            {TEST_LEVELS.map(level => {
              const stimEvents = events.filter(e => e.stimulus === level.key)
              const disappearCount = stimEvents.filter(e => e.type === 'disappear').length
              const reappearCount = stimEvents.filter(e => e.type === 'reappear').length
              const area = areas[level.key]
              return (
                <div key={level.key} className="bg-gray-900 rounded-lg px-3 py-2 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: STIMULI[level.key].color }} />
                    <span className="font-medium">{level.key}</span>
                    {area != null && (
                      <span className="text-gray-400 font-mono text-xs ml-auto">
                        {area.toFixed(0)} deg² (~{Math.sqrt(area / Math.PI).toFixed(1)}° radius)
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    {disappearCount} disappearances, {reappearCount} reappearances across {numSectors} sectors
                  </div>
                </div>
              )
            })}
          </div>
          <ClinicalDisclaimer variant="results" />
          <Interpretation points={pts} areas={areas} maxEccentricityDeg={maxEcc} calibration={calibration} />
          <ScenarioOverlay userPoints={pts} userAreas={areas} maxEccentricity={maxEcc} />

          {/* Vision simulation — collapsible */}
          {!showVisionSim ? (
            <button
              onClick={() => setShowVisionSim(true)}
              className="w-full py-3 bg-gray-900 hover:bg-gray-800 rounded-xl font-medium transition-colors border border-gray-800 hover:border-gray-700 text-sm"
            >
              <svg className="inline w-4 h-4 mr-1.5 -mt-0.5 text-blue-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
                <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
              Vision simulation
            </button>
          ) : (
            <div className="space-y-2">
              <button onClick={() => setShowVisionSim(false)} className="text-xs text-gray-500 hover:text-gray-300 transition-colors">
                ▾ Hide vision simulation
              </button>
              <VisionSimulator points={pts} eye={eye} maxEccentricity={maxEcc} />
            </div>
          )}

          {/* Survey — collapsed by default */}
          {savedId && !surveyDone && !hasSurveyForResult(savedId) && (
            <details className="group">
              <summary className="cursor-pointer text-center text-sm text-gray-400 hover:text-gray-300 transition-colors py-2 list-none">
                <svg className="inline w-4 h-4 mr-1.5 -mt-0.5 text-gray-500 group-open:rotate-90 transition-transform" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                  <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clipRule="evenodd" />
                </svg>
                Quick feedback (optional)
              </summary>
              <div className="mt-3">
                <PostTestSurvey
                  onSubmit={(response: SurveyResponse) => {
                    saveSurvey(savedId, response)
                    setSurveyDone(true)
                  }}
                  onSkip={() => setSurveyDone(true)}
                />
              </div>
            </details>
          )}
          {surveyDone && (
            <p className="text-center text-green-400 text-xs">Thank you for your feedback!</p>
          )}

          <div className="flex gap-3">
            <button
              onClick={() => {
                if (!savedId) return
                const result: TestResult = {
                  id: savedId,
                  eye,
                  date: new Date().toISOString(),
	                  points: pts,
	                  isopterAreas: areas,
	                  calibration,
	                  testType: 'ring',
	                  durationSeconds: getTestDurationSeconds(),
	                }
                exportTrackedResultPDF(result)
              }}
              className="flex-1 py-3 btn-primary rounded-xl font-medium text-white"
            >
              Export PDF
            </button>
            <button
              onClick={handleFinish}
              className="flex-1 py-3 bg-gray-800 hover:bg-gray-700 rounded-lg font-medium transition-colors"
            >
              Done
            </button>
          </div>
        </main>
      </div>
    )
  }

  // ---- Active test ----
  return (
    <div className="fixed inset-0 bg-black cursor-none" role="application" aria-label="Ring visual field test - use arrow keys to expand ring, Space to mark boundaries">
      <canvas ref={canvasRef} className="w-full h-full" />
      {/* Head positioning guide — Goldmann-style, shown until user starts moving the arc */}
      {!hasMovedArc && (() => {
        const gw = 280
        const gh = 160
        const headX = gw / 2
        const dotX = gw / 2 + (fixOffsetX / (typeof window !== 'undefined' ? window.innerWidth : 1440)) * gw * 0.6
        const eyeLabel = eye === 'right' ? 'R' : 'L'
        const coveredLabel = eye === 'right' ? 'L' : 'R'
        return (
          <div
            className="fixed pointer-events-none opacity-50 transition-opacity"
            style={{ left: fixX, top: fixY + 30, transform: 'translateX(-50%)' }}
          >
            <svg viewBox={`0 0 ${gw} ${gh}`} width={gw} height={gh} aria-hidden="true">
              {/* Head silhouette */}
              <ellipse cx={headX} cy={gh * 0.42} rx={38} ry={46} fill="none" stroke="#475569" strokeWidth={1.5} />
              {/* Neck */}
              <rect x={headX - 14} y={gh * 0.42 + 40} width={28} height={20} rx={4} fill="none" stroke="#475569" strokeWidth={1.5} />
              {/* Shoulders */}
              <path d={`M ${headX - 14} ${gh * 0.42 + 55} Q ${headX - 60} ${gh * 0.42 + 58} ${headX - 70} ${gh * 0.42 + 80}`} fill="none" stroke="#475569" strokeWidth={1.5} />
              <path d={`M ${headX + 14} ${gh * 0.42 + 55} Q ${headX + 60} ${gh * 0.42 + 58} ${headX + 70} ${gh * 0.42 + 80}`} fill="none" stroke="#475569" strokeWidth={1.5} />
              {/* Eyes */}
              <circle cx={headX - 14} cy={gh * 0.38} r={4} fill={eye === 'left' ? '#fbbf24' : '#475569'} opacity={eye === 'left' ? 1 : 0.3} />
              <circle cx={headX + 14} cy={gh * 0.38} r={4} fill={eye === 'right' ? '#fbbf24' : '#475569'} opacity={eye === 'right' ? 1 : 0.3} />
              {/* X over covered eye */}
              {eye === 'right' ? (
                <>
                  <line x1={headX - 18} y1={gh * 0.38 - 4} x2={headX - 10} y2={gh * 0.38 + 4} stroke="#ef4444" strokeWidth={1.5} />
                  <line x1={headX - 18} y1={gh * 0.38 + 4} x2={headX - 10} y2={gh * 0.38 - 4} stroke="#ef4444" strokeWidth={1.5} />
                </>
              ) : (
                <>
                  <line x1={headX + 10} y1={gh * 0.38 - 4} x2={headX + 18} y2={gh * 0.38 + 4} stroke="#ef4444" strokeWidth={1.5} />
                  <line x1={headX + 10} y1={gh * 0.38 + 4} x2={headX + 18} y2={gh * 0.38 - 4} stroke="#ef4444" strokeWidth={1.5} />
                </>
              )}
              {/* Eye labels */}
              <text x={headX - 14} y={gh * 0.38 + 16} fill="#64748b" fontSize={9} textAnchor="middle">{coveredLabel === 'L' ? 'L' : eyeLabel}</text>
              <text x={headX + 14} y={gh * 0.38 + 16} fill="#64748b" fontSize={9} textAnchor="middle">{coveredLabel === 'R' ? 'R' : eyeLabel}</text>
              {/* Fixation dot indicator */}
              <circle cx={dotX} cy={gh * 0.15} r={4} fill="#fbbf24" />
              <text x={dotX} y={gh * 0.15 - 10} fill="#fbbf24" fontSize={9} textAnchor="middle">fixation</text>
              {/* Dashed line from active eye to fixation */}
              <line
                x1={eye === 'right' ? headX + 14 : headX - 14} y1={gh * 0.38 - 5}
                x2={dotX} y2={gh * 0.15 + 5}
                stroke="#fbbf24" strokeWidth={0.8} strokeDasharray="3,3" opacity={0.5}
              />
              {/* Screen line */}
              <line x1={20} y1={gh * 0.08} x2={gw - 20} y2={gh * 0.08} stroke="#334155" strokeWidth={1} />
              <text x={gw / 2} y={gh * 0.08 - 4} fill="#334155" fontSize={8} textAnchor="middle">screen</text>
              {/* Scroll to begin */}
              <text x={gw / 2} y={gh - 4} fill="#475569" fontSize={10} textAnchor="middle">Scroll to begin</text>
            </svg>
          </div>
        )
      })()}
      <div className="fixed top-4 left-4 text-xs space-y-1 pointer-events-none" aria-live="polite">
        <div className="text-gray-600">
          <span style={{ color: STIMULI[currentLevel.key].color }}>{currentLevel.key}</span>
          <span className="ml-2">sector {sectorIdx + 1}/{numSectors}</span>
        </div>
        <div className="text-gray-700">Sweep {currentSweep}/{totalSweeps}</div>
        {lastAction && <div className="text-gray-600">{lastAction}</div>}
      </div>
      <div className="fixed bottom-6 left-0 right-0 text-center pointer-events-none space-y-1">
        <p className="text-gray-700 text-xs">Scroll/↑↓ = expand · Left click/Space = mark · Middle click/Enter = next · Shift = prev · Right click = undo</p>
      </div>
    </div>
  )
}
