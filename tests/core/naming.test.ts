import { describe, expect, it } from 'vitest'
import { NAME_TOKENS, renderNameTemplate, type NamingVars } from '../../src/shared/naming'

const vars = (over: Partial<NamingVars> = {}): NamingVars => ({
  name: 'IMG_0001',
  ext: 'jpg',
  preset: 'Copy & rename',
  parent: '旅行 2024',
  counter: 7,
  now: new Date(2026, 9, 1, 23, 59, 58),
  ...over,
})

describe('naming tokens {exifdate} {exiftime} {mdate}', () => {
  it('are listed for the UI', () => {
    expect(NAME_TOKENS).toEqual(expect.arrayContaining(['{exifdate}', '{exiftime}', '{mdate}']))
  })

  it('use the photo taken time and the file modified time', () => {
    const v = vars({ taken: new Date(2021, 6, 4, 13, 45, 10), modified: new Date(2022, 0, 2, 3, 4, 5) })
    expect(renderNameTemplate('{exifdate}_{exiftime}_{counter:3}', v)).toBe('2021-07-04_134510_007')
    expect(renderNameTemplate('{mdate} {name}', v)).toBe('2022-01-02 IMG_0001')
    expect(renderNameTemplate('{date}', v)).toBe('2026-10-01')
  })

  it('{exifdate}/{exiftime} fall back to modified, then now; {mdate} falls back to now', () => {
    expect(renderNameTemplate('{exifdate}_{exiftime}', vars({ modified: new Date(2019, 4, 6, 7, 8, 9) }))).toBe('2019-05-06_070809')
    expect(renderNameTemplate('{exifdate}_{exiftime}', vars())).toBe('2026-10-01_235958')
    expect(renderNameTemplate('{mdate}', vars({ taken: new Date(2000, 0, 1) }))).toBe('2026-10-01')
  })

  it('combines with the other tokens and stays a safe file name', () => {
    const v = vars({ taken: new Date(2023, 11, 31, 8, 0, 0) })
    expect(renderNameTemplate('{parent}/{exifdate}: {name}', v)).toBe('旅行 2024_2023-12-31_ IMG_0001')
  })
})
