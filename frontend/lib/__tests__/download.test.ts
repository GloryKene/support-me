import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { downloadBlob, DOWNLOAD_REVOKE_DELAY_MS } from '@/lib/download';

describe('downloadBlob', () => {
  const clickSpy = vi.fn();

  beforeEach(() => {
    clickSpy.mockReset();
    vi.useFakeTimers();
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:mock-url'),
      revokeObjectURL: vi.fn(),
    });
    // downloadBlob builds a throwaway <a download> and clicks it; jsdom
    // implements .click() but it is not observable, so the anchor's own
    // click method is replaced here (restored after every test).
    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = originalCreateElement(tag);
      if (tag === 'a') el.click = clickSpy;
      return el;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('starts the download but does not revoke the object URL immediately', () => {
    const appendSpy = vi.spyOn(document.body, 'appendChild');
    const blob = new Blob(['hello'], { type: 'text/plain' });

    downloadBlob(blob, 'hello.txt');

    expect(URL.createObjectURL).toHaveBeenCalledWith(blob);
    expect(clickSpy).toHaveBeenCalledOnce();
    const anchor = appendSpy.mock.calls
      .map(([node]) => node)
      .find((node): node is HTMLAnchorElement => node instanceof HTMLAnchorElement);
    expect(anchor?.download).toBe('hello.txt');
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });

  it('revokes the object URL once the delay has passed', () => {
    downloadBlob(new Blob(['hello'], { type: 'text/plain' }), 'hello.txt');

    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(DOWNLOAD_REVOKE_DELAY_MS);
    expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
  });
});
