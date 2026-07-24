import { Injectable } from '@nestjs/common';
import { v2 as cloudinary, UploadApiResponse } from 'cloudinary';
import { Readable } from 'stream';

@Injectable()
export class CloudinaryService {
  // Pour les uploads venant du front (affiches, photos de profil)
  async uploadImage(
    file: Express.Multer.File,
    folder: string,
  ): Promise<UploadApiResponse> {
    return new Promise((resolve, reject) => {
      const upload = cloudinary.uploader.upload_stream(
        {
          folder,
          resource_type: 'image',
          transformation: [{ quality: 'auto', fetch_format: 'auto' }],
        },
        (error, result) => {
          if (error) return reject(error);
          if (!result) return reject(new Error('Upload Cloudinary sans résultat.'));
          resolve(result);
        },
      );
      Readable.from(file.buffer).pipe(upload);
    });
  }

  // Pour les images générées côté serveur (billets avec QR code)
  async uploadBuffer(
    buffer: Buffer,
    folder: string,
  ): Promise<UploadApiResponse> {
    return new Promise((resolve, reject) => {
      const upload = cloudinary.uploader.upload_stream(
        {
          folder,
          resource_type: 'image',
          transformation: [{ quality: 'auto', fetch_format: 'auto' }],
        },
        (error, result) => {
          if (error) return reject(error);
          if (!result) return reject(new Error('Upload Cloudinary sans résultat.'));
          resolve(result);
        },
      );
      Readable.from(buffer).pipe(upload);
    });
  }

  async deleteImage(publicId: string) {
    return cloudinary.uploader.destroy(publicId);
  }
}