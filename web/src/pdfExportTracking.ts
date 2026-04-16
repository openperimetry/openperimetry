import { trackEvent } from './api'
import { exportResultPDF } from './pdfExport'
import type { PDFExportOptions } from './pdfExport'
import { getDeviceId } from './storage'
import type { TestResult } from './types'

type PDFExportSource = 'result_screen' | 'history_detail' | 'history_list' | 'binocular_results' | 'demo'

export function exportTrackedResultPDF(
  result: TestResult,
  options?: PDFExportOptions,
  source: PDFExportSource = 'result_screen',
): void {
  exportResultPDF(result, options)
    .then(() => {
      const durationSeconds = result.durationSeconds
      const eye = options?.binocular ? 'both' : result.eye
      const meta: Record<string, string> = {
        source,
        resultId: result.id,
        testType: result.testType ?? 'unknown',
        eye,
        points: String(result.points.length),
        detected: String(result.points.filter(p => p.detected).length),
      }

      if (durationSeconds != null) {
        meta.durationSeconds = String(durationSeconds)
      }

      trackEvent('pdf_exported', getDeviceId(), meta).catch(() => {})
    })
    .catch(() => {})
}
