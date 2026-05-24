import { describe, it, expect, vi } from 'vitest'
import {
  opacityToDb,
  dbToOpacity,
  jetReverseColor,
  renderSensitivityToCanvas,
  DB_MIN,
  DB_MAX,
} from './sensitivity'

describe('opacityToDb', () => {
  it('returns 0 dB at max opacity', () => {
    expect(opacityToDb(1.0)).toBeCloseTo(0, 6)
  })
  it('returns 10 dB at 1 log unit dimmer', () => {
    expect(opacityToDb(0.1)).toBeCloseTo(10, 6)
  })
  it('is monotone: dimmer stimulus → higher dB', () => {
    expect(opacityToDb(0.5)).toBeGreaterThan(opacityToDb(1.0))
    expect(opacityToDb(0.05)).toBeGreaterThan(opacityToDb(0.5))
  })
  it('returns DB_MAX for opacity <= 0', () => {
    expect(opacityToDb(0)).toBe(DB_MAX)
    expect(opacityToDb(-0.1)).toBe(DB_MAX)
  })
  it('round-trips via dbToOpacity', () => {
    for (const op of [1.0, 0.5, 0.3, 0.1, 0.05]) {
      expect(dbToOpacity(opacityToDb(op))).toBeCloseTo(op, 6)
    }
  })
})

describe('dbToOpacity', () => {
  it('dbToOpacity guards non-finite input', () => {
    expect(dbToOpacity(NaN)).toBe(0)
    expect(dbToOpacity(-Infinity)).toBe(0)
    expect(dbToOpacity(Infinity)).toBe(0)
  })
  it('dbToOpacity clamps to [0, 1]', () => {
    // Negative dB would exceed 1 mathematically (brighter than max)
    expect(dbToOpacity(-5)).toBe(1)
  })
})

describe('range constants', () => {
  it('DB_MAX > DB_MIN', () => {
    expect(DB_MAX).toBeGreaterThan(DB_MIN)
  })
})

describe('jetReverseColor', () => {
  it('low t yields the warm (red) region of jet_r', () => {
    const { r, g, b } = jetReverseColor(0)
    expect(r).toBeGreaterThan(g)
    expect(r).toBeGreaterThan(b)
    expect(b).toBe(0)
  })
  it('high t yields the cool (blue) region of jet_r', () => {
    const { r, g, b } = jetReverseColor(1)
    expect(b).toBeGreaterThan(g)
    expect(b).toBeGreaterThan(r)
    expect(r).toBe(0)
  })
  it('clamps out-of-range t to the defined endpoints', () => {
    expect(jetReverseColor(-5)).toEqual(jetReverseColor(0))
    expect(jetReverseColor(5)).toEqual(jetReverseColor(1))
  })
  it('returns components in 0–255 range', () => {
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const { r, g, b } = jetReverseColor(t)
      for (const c of [r, g, b]) {
        expect(c).toBeGreaterThanOrEqual(0)
        expect(c).toBeLessThanOrEqual(255)
      }
    }
  })
})

describe('renderSensitivityToCanvas', () => {
  /** Build a minimal 2D-context stub that records the primary calls the
   *  renderer makes. Just enough surface for the function to run — we
   *  assert on which methods were invoked, not on pixel output. */
  function makeCtxStub(size: number) {
    const imageData = { data: new Uint8ClampedArray(size * size * 4), width: size, height: size }
    return {
      clearRect: vi.fn(),
      createImageData: vi.fn(() => imageData),
      putImageData: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      strokeStyle: '',
      lineWidth: 0,
    } as unknown as CanvasRenderingContext2D & { putImageData: ReturnType<typeof vi.fn>; clearRect: ReturnType<typeof vi.fn> }
  }

  it('clears the canvas and paints when given threshold points', () => {
    const ctx = makeCtxStub(60) as ReturnType<typeof makeCtxStub>
    renderSensitivityToCanvas(
      ctx,
      [
        { meridianDeg: 0, eccentricityDeg: 10, db: 25 },
        { meridianDeg: 90, eccentricityDeg: 10, db: 30 },
      ],
      60,
      30,
    )
    expect(ctx.clearRect).toHaveBeenCalled()
    expect(ctx.putImageData).toHaveBeenCalled()
  })

  it('bails early with no points', () => {
    const ctx = makeCtxStub(60) as ReturnType<typeof makeCtxStub>
    renderSensitivityToCanvas(ctx, [], 60, 30)
    expect(ctx.clearRect).toHaveBeenCalled()
    expect(ctx.putImageData).not.toHaveBeenCalled()
  })

  it('bails early with non-positive max eccentricity', () => {
    const ctx = makeCtxStub(60) as ReturnType<typeof makeCtxStub>
    renderSensitivityToCanvas(
      ctx,
      [{ meridianDeg: 0, eccentricityDeg: 10, db: 25 }],
      60,
      0,
    )
    expect(ctx.putImageData).not.toHaveBeenCalled()
  })
})
