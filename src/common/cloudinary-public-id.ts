export function publicIdFromUrl(SecureUrl: string, keepExtension = false): string {
    const parts = SecureUrl.split('/upload/');
    if (parts.length < 2) {
        throw new Error(`URL Cloudinary inattendue  : ${SecureUrl}`);
    }

    const afterUpload = parts[1].replace(/^v\d+\//, ''); // retire le segment de version "v123/"
    return keepExtension ? afterUpload : afterUpload.replace(/\.[^/.]+$/, ''); // retire l'extension si keepExtension = false
} 