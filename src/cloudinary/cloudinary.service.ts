import { Injectable } from '@nestjs/common';
import { v2 as cloudinary, UploadApiResponse } from 'cloudinary';
import { resolve } from 'path';
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

  // Upload générique selon le type détecté (image OU pdf/document).
  // resourceType 'auto' laisse Cloudinary router correctement le PDF ; la
  // transformation image n'est appliquée qu'aux images (inadaptée aux PDF).
  async uploadFile(
    file: Express.Multer.File,
    folder: string,
    resourceType: 'image' | 'auto',
  ): Promise<UploadApiResponse> {
    return new Promise((resolve, reject) => {
      const upload = cloudinary.uploader.upload_stream(
        {
          folder,
          resource_type: resourceType,
          transformation:
            resourceType === 'image'
              ? [{ quality: 'auto', fetch_format: 'auto' }]
              : undefined,
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

  async uploadRawBuffer( buffer: Buffer, folder: string, filename: string): Promise<UploadApiResponse> {
    return new Promise((resolve, reject) => {
      const upload = cloudinary.uploader.upload_stream(
        {
          folder,
          resource_type: 'raw',
          public_id: filename, // Nom du fichier sans extension
          format: 'pdf',// Forcer le format PDF pour les fichiers bruts
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

  async uploadAny(
    file: Express.Multer.File,
    folder: string,
  ): Promise<UploadApiResponse>{
    return new Promise((resolve, reject) => {
      const upload =  cloudinary.uploader.upload_stream({
        folder, 
        resource_type: 'auto',  // 'image' pour jpg/png/webp/gif, 'raw' pour pdf, etc.
        },(error, result) => {
          if (error) return reject(error);
          if (!result) return reject(new Error('Upload Cloudinary sans résultat.'));
          resolve(result);},); Readable.from(file.buffer).pipe(upload);})
  }

  async deleteAsset(publicId: string, resourceType: 'image' | 'raw' = 'image') {
    return cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
  }
}