import { BadRequestException } from '@nestjs/common';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './constants';
import { parseLimit, encodeCursor, decodeCursor, buildPage } from './pagination';

describe('pagination', () => {
  describe('parseLimit', () => {
    it('défaut si absent', () => {
      expect(parseLimit(undefined)).toBe(DEFAULT_PAGE_SIZE);
      expect(parseLimit('')).toBe(DEFAULT_PAGE_SIZE);
    });
    it('plafonne à MAX_PAGE_SIZE', () => {
      expect(parseLimit(String(MAX_PAGE_SIZE + 50))).toBe(MAX_PAGE_SIZE);
    });
    it('accepte une valeur valide', () => {
      expect(parseLimit('10')).toBe(10);
    });
    it('rejette une valeur non numérique ou < 1', () => {
      expect(() => parseLimit('abc')).toThrow(BadRequestException);
      expect(() => parseLimit('0')).toThrow(BadRequestException);
    });
  });

  describe('encode/decode cursor', () => {
    it('round-trip', () => {
      const c = { v: '2026-01-01T00:00:00.000Z', id: 'abc' };
      expect(decodeCursor(encodeCursor(c))).toEqual(c);
    });
    it('absent → null', () => {
      expect(decodeCursor(undefined)).toBeNull();
    });
    it('malformé → 400 (jamais ignoré silencieusement)', () => {
      expect(() => decodeCursor('pas-du-base64-json!')).toThrow(BadRequestException);
    });
  });

  describe('buildPage', () => {
    const toCursor = (n: number) => ({ v: String(n), id: String(n) });
    it('page pleine (rows = limit+1) → nextCursor depuis le dernier gardé', () => {
      const page = buildPage([1, 2, 3], 2, toCursor);
      expect(page.items).toEqual([1, 2]);
      expect(page.nextCursor).toBe(encodeCursor(toCursor(2)));
    });
    it('dernière page (rows <= limit) → nextCursor null', () => {
      const page = buildPage([1, 2], 2, toCursor);
      expect(page.items).toEqual([1, 2]);
      expect(page.nextCursor).toBeNull();
    });
  });
});
