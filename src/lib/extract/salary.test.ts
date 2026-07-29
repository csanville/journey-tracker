import { describe, expect, it } from 'vitest'
import { parseBaseSalary } from './salary'

describe('parseBaseSalary', () => {
  it('reads the shape schema.org documents', () => {
    expect(
      parseBaseSalary({
        '@type': 'MonetaryAmount',
        currency: 'USD',
        value: {
          '@type': 'QuantitativeValue',
          minValue: 180000,
          maxValue: 220000,
          unitText: 'YEAR',
        },
      }),
    ).toEqual({
      min: 180000,
      max: 220000,
      currency: 'USD',
      period: 'year',
      raw: 'USD 180,000–USD 220,000 per year',
    })
  })

  it('reads a single figure and numeric strings', () => {
    expect(
      parseBaseSalary({ currency: 'gbp', value: { value: '65000', unitText: 'YEAR' } }),
    ).toMatchObject({ min: 65000, max: 65000, currency: 'GBP', period: 'year' })
  })

  it('orders a range whose ends arrived backwards', () => {
    const salary = parseBaseSalary({
      value: { minValue: 220000, maxValue: 180000, unitText: 'YEAR' },
    })

    expect(salary).toMatchObject({ min: 180000, max: 220000 })
  })

  it('refuses a zero, a negative, and an unparseable string', () => {
    // `Number('')` is 0 and `Number('120k')` is NaN. A salary of zero written
    // into a record reads as a real figure forever, so neither is coerced.
    expect(parseBaseSalary({ value: { value: 0 } })).toBeNull()
    expect(parseBaseSalary({ value: { value: -5 } })).toBeNull()
    expect(parseBaseSalary({ value: { value: '120k' } })).toBeNull()
    expect(parseBaseSalary({ value: { value: '' } })).toBeNull()
  })

  it('refuses a figure that is a units mistake rather than a wage', () => {
    expect(parseBaseSalary({ value: { value: 999_000_000 } })).toBeNull()
  })

  it('keeps only a real currency code', () => {
    // `$` and "US dollars" are not ISO 4217. Storing either makes two records
    // incomparable, and the amount is still worth having without it.
    expect(parseBaseSalary({ currency: '$', value: { value: 1000 } })).toMatchObject({
      currency: null,
    })
    expect(
      parseBaseSalary({ currency: 'US dollars', value: { value: 1000 } }),
    ).toMatchObject({ currency: null })
  })

  it('ignores an unrecognised period rather than guessing one', () => {
    expect(
      parseBaseSalary({ value: { value: 1000, unitText: 'FORTNIGHT' } }),
    ).toMatchObject({ period: null })
  })

  it('returns null for anything that is not a salary', () => {
    expect(parseBaseSalary(undefined)).toBeNull()
    expect(parseBaseSalary(null)).toBeNull()
    expect(parseBaseSalary('competitive')).toBeNull()
    expect(parseBaseSalary({ currency: 'USD' })).toBeNull()
  })
})
