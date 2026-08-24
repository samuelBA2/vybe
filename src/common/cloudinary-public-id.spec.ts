import { publicIdFromUrl } from './cloudinary-public-id';

describe('publicIdFromUrl', () => {
    
it('image PNG : retire version + extension, garde le dossier', () => {
    const url = 'https://res.cloudinary.com/demo/image/upload/v1699999999/tickets/abc123.png';
    expect(publicIdFromUrl(url)).toBe('tickets/abc123');
});

it ('raw PDF : avec keepExtesion : conserve l\'extension',() => { 
    const url = 'https://res.cloudinary.com/demo/raw/upload/v170/tickets/ticket-xyz.pdf'
    expect(publicIdFromUrl(url, true)).toBe('tickets/ticket-xyz.pdf');
})

it('raw PDF sans keepExtension : retire l’extension (fallback)', () => {
    const url = 'https://res.cloudinary.com/demo/raw/upload/v170/tickets/ticket-xyz.pdf';
    expect(publicIdFromUrl(url)).toBe('tickets/ticket-xyz');
});
it('URL sans segment /upload/ : lève une erreur explicite', () => {
    expect(() => publicIdFromUrl('https://example.com/foo.png')).toThrow('URL Cloudinary inattendue');
});
});