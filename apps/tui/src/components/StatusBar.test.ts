/**
 * The plan windows, drawn as bars.
 *
 * A bar is read at a glance where three percentages have to be compared, so
 * it has to be honest at both ends: a window someone has started on must not
 * look untouched, and a window that is not yet full must not look full.
 */

import { describe, expect, it } from 'vitest';

import { meterBar, meterCells, meterTone } from './StatusBar.js';

describe('meterBar', () => {
  it('fills in proportion', () => {
    expect(meterBar(0, 8)).toBe('░░░░░░░░');
    expect(meterBar(50, 8)).toBe('████░░░░');
    expect(meterBar(100, 8)).toBe('████████');
  });

  it('lights the first cell for any use at all', () => {
    // 1% of eight cells rounds to nothing; a window being used must not read
    // as a window untouched.
    expect(meterBar(1, 8)).toBe('█░░░░░░░');
    expect(meterBar(0.4, 8)).toBe('█░░░░░░░');
  });

  it('holds the last cell back until the window really is full', () => {
    // Otherwise 97% and 100% are the same picture, and the one that matters
    // is the one that stops you working.
    expect(meterBar(97, 8)).toBe('███████░');
    expect(meterBar(99.6, 8)).toBe('███████░');
    expect(meterBar(100, 8)).toBe('████████');
    expect(meterBar(140, 8)).toBe('████████');
  });
});

describe('meterCells', () => {
  it('gives up the bars before it squeezes the line beside them', () => {
    // The readings sit in a box that does not shrink; every cell is a column
    // taken from the account and model line, which truncates. Eight cells
    // each cost "BYPASS PERMISSIONS" its tail on a 140-column terminal.
    // The width given is this bar's own — the terminal less the rail.
    expect(meterCells(120)).toBe(5);
    expect(meterCells(100)).toBe(4);
    expect(meterCells(80)).toBe(0);
  });
});

/*
 * Colour by pressure, as the desktop colours its rings — and the same
 * thresholds, so an account is never amber in one app and red in the other.
 * Below the warning bands the bar was dim grey, which read as a meter that
 * was switched off rather than one that was fine.
 */
describe('meterTone', () => {
  it('is green while there is room, yellow at 75 and red at 90', () => {
    expect(meterTone(0)).toBe('green');
    expect(meterTone(74.9)).toBe('green');
    expect(meterTone(75)).toBe('yellow');
    expect(meterTone(89.9)).toBe('yellow');
    expect(meterTone(90)).toBe('red');
  });

  it('is red whatever the number says once the provider is rejecting', () => {
    // A stale 40% on a window the provider has shut is the far end of the
    // scale, not the middle.
    expect(meterTone(40, 'rejected')).toBe('red');
  });

  it('has no tone for a window with no reading', () => {
    expect(meterTone(null)).toBeUndefined();
  });
});
