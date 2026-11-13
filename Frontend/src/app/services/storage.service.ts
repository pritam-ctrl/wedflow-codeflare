import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, switchMap } from 'rxjs';
import { environment } from '../../environments/environment';
import { Auth } from './auth';

export interface StorageFile {
  id: string;
  name: string;
  customer: string;
  bookingId: string;
  bookingNumber: string;
  sizeLabel: string;
  sizeBytes: number;
  fileClass: 'client-gallery' | 'internal-archive';
  storageClass: 'STANDARD' | 'INFREQUENT_ACCESS';
  isOriginal: boolean;
  parentFileId?: string;
  badge: string;
  action: string;
  uploadDate: string;
  fileType: string;
  category: string;
  storagePath: string;
  status: string;
}

export interface StorageStats {
  usedBytes: number;
  usedLabel: string;
  uploadingLabel: string;
  availableLabel: string;
  totalLabel: string;
  filesCount: number;
  usagePercent: number;
  planName?: string;
}

export interface UpgradeRequestPayload {
  workspaceId?: string;
  requestType: 'plan_upgrade' | 'topup_block';
  planName?: string;
  additionalGB: number;
  priceQuoted?: number;
  paymentReference: string;
}

export interface BookingOption {
  id: string;
  label: string;
  clientName: string;
}

export interface UploadFileData {
  workspaceId?: string;
  bookingId: string;
  fileName: string;
  fileType: string;
  fileClass?: 'client-gallery' | 'internal-archive';
  category: string;
  fileSize: number;
  storagePath?: string;
  status?: string;
  notes?: string;
}

@Injectable({
  providedIn: 'root'
})
export class StorageService {
  private apiUrl = environment.apiUrl || 'http://localhost:5001/api';
  private auth = inject(Auth);

  constructor(private http: HttpClient) {}

  private getHeaders(): { headers: HttpHeaders } {
    const token = this.auth.getToken();
    let headers = new HttpHeaders();
    if (token) {
      headers = headers.set('Authorization', `Bearer ${token}`);
    }
    return { headers };
  }

  // Get storage usage breakdown
  getStorageUsage(): Observable<any> {
    return this.http.get(`${this.apiUrl}/storage/usage`, this.getHeaders());
  }

  // Submit upgrade / one-time top-up request
  submitUpgradeRequest(payload: UpgradeRequestPayload): Observable<any> {
    return this.http.post(`${this.apiUrl}/storage/upgrade-request`, payload, this.getHeaders());
  }

  // Get upgrade requests history
  getUpgradeRequests(): Observable<{ requests: any[] }> {
    return this.http.get<{ requests: any[] }>(`${this.apiUrl}/storage/upgrade-requests`, this.getHeaders());
  }

  // Get storage statistics
  getStorageStats(): Observable<StorageStats> {
    return this.http.get<StorageStats>(`${this.apiUrl}/storage/stats`, this.getHeaders());
  }

  // Get all files with optional filtering
  getFiles(filters?: {
    searchTerm?: string;
    category?: string;
    status?: string;
  }): Observable<{ success: boolean; files: StorageFile[]; count: number }> {
    const params: any = {};
    if (filters?.searchTerm) params.search = filters.searchTerm;
    if (filters?.category) params.category = filters.category;
    if (filters?.status) params.status = filters.status;

    return this.http.get<{ success: boolean; files: StorageFile[]; count: number }>(
      `${this.apiUrl}/files/enhanced`,
      { params, ...this.getHeaders() }
    );
  }

  // Get booking options for upload form
  getBookingOptions(): Observable<{ success: boolean; bookings: any[] }> {
    return this.http.get<{ success: boolean; bookings: any[] }>(`${this.apiUrl}/bookings`, this.getHeaders());
  }

  /**
   * Complete S3 Upload Flow:
   * 1. Request presigned upload URL from backend (with quota check)
   * 2. Direct PUT upload to S3 bucket
   * 3. Confirm file in PostgreSQL files table
   */
  uploadFile(fileData: UploadFileData, file: File): Observable<any> {
    const targetFileClass = fileData.fileClass || 'client-gallery';
    const user = this.auth.getUser();
    const wsId = fileData.workspaceId || user?.workspace_id;

    return this.http.post<any>(`${this.apiUrl}/storage/upload-url`, {
      workspace_id: wsId,
      bookingId: fileData.bookingId,
      fileName: file.name,
      fileClass: targetFileClass,
      contentType: file.type || 'application/octet-stream',
      sizeBytes: file.size
    }, this.getHeaders()).pipe(
      switchMap((presignedRes) => {
        // Direct S3 PUT
        return new Observable((observer) => {
          const xhr = new XMLHttpRequest();
          xhr.open('PUT', presignedRes.uploadUrl, true);
          if (file.type) {
            xhr.setRequestHeader('Content-Type', file.type);
          }
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              observer.next(presignedRes);
              observer.complete();
            } else {
              observer.error(new Error(`S3 upload failed with status ${xhr.status}`));
            }
          };
          xhr.onerror = () => observer.error(new Error('S3 upload network error'));
          xhr.send(file);
        });
      }),
      switchMap((presignedRes: any) => {
        // Confirm upload in database
        return this.http.post(`${this.apiUrl}/storage/confirm-upload`, {
          workspace_id: wsId,
          bookingId: fileData.bookingId,
          fileName: file.name,
          fileType: file.type,
          fileClass: targetFileClass,
          category: fileData.category,
          s3Key: presignedRes.key,
          sizeBytes: file.size,
          notes: fileData.notes
        }, this.getHeaders());
      })
    );
  }

  /**
   * Download / Restore handling:
   * - STANDARD or GLACIER_IR: returns immediate downloadUrl
   * - DEEP_ARCHIVE: triggers restore job and returns ETA status
   */
  requestFileDownload(fileId: string): Observable<{
    immediate: boolean;
    downloadUrl?: string;
    restoreStatus?: string;
    message?: string;
    storageClass?: string;
  }> {
    return this.http.get<{
      immediate: boolean;
      downloadUrl?: string;
      restoreStatus?: string;
      message?: string;
      storageClass?: string;
    }>(`${this.apiUrl}/storage/files/${fileId}/download`, this.getHeaders());
  }

  // Delete file
  deleteFile(fileId: string): Observable<any> {
    return this.http.delete(`${this.apiUrl}/files/${fileId}`, this.getHeaders());
  }

  // Restore file legacy alias
  restoreFile(fileId: string): Observable<any> {
    return this.requestFileDownload(fileId);
  }

  // Format file size for display
  formatFileSize(bytes: number): string {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  // Map database file to frontend StorageFile format
  mapToFileFormat(dbFile: any, bookingNumber: string, clientName: string): StorageFile {
    const storageClass = dbFile.storage_class || 'STANDARD';
    const fileClass = dbFile.file_class || 'client-gallery';
    const isOriginal = dbFile.is_original !== false;

    let badge = storageClass === 'INFREQUENT_ACCESS' ? 'Infrequent Access' : 'Standard';

    return {
      id: dbFile.id,
      name: dbFile.file_name,
      customer: clientName,
      bookingId: dbFile.booking_id,
      bookingNumber: bookingNumber,
      sizeLabel: this.formatFileSize(dbFile.file_size || 0),
      sizeBytes: dbFile.file_size || 0,
      fileClass,
      storageClass,
      isOriginal,
      parentFileId: dbFile.parent_file_id,
      badge,
      action: 'download',
      uploadDate: dbFile.upload_date,
      fileType: dbFile.file_type,
      category: dbFile.category,
      storagePath: dbFile.storage_path,
      status: dbFile.status
    };
  }
}
