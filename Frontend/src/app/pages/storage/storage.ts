import { Component, signal, computed, inject, OnInit, HostListener, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { StorageService, StorageFile, BookingOption } from '../../services/storage.service';

type FileTypeOption = { value: string; label: string };

@Component({
  selector: 'app-storage',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './storage.html',
  styleUrl: './storage.scss',
})
export class Storage implements OnInit {
  private storageService = inject(StorageService);
  private elementRef = inject(ElementRef);
  // ==== stats ====
  usedBytes = signal(0);
  usedLabel = signal('0 B');
  uploadingLabel = signal('0 B');
  availableLabel = signal('1.00 TB');
  totalLabel = signal('1.00 TB');
  filesCount = signal(0);
  isLoadingStats = signal(false);

  // percentage — real calculation (1TB = 1024*1024*1024*1024 bytes... using GB-based approx here for simplicity)
  usagePercent = computed(() => {
    const totalBytes = 1024 * 1024 * 1024 * 1024; // 1 TB in bytes (approx, binary)
    const pct = (this.usedBytes() / totalBytes) * 100;
    return Math.max(pct, 0.05); // floor so a sliver is always visible
  });

  // ==== Cloudflare R2 tiering + estimated cost ====
  private static readonly GB = 1024 * 1024 * 1024;
  // Published R2 pricing (USD per GB / month)
  private static readonly STANDARD_RATE = 0.015;
  private static readonly INFREQUENT_RATE = 0.01;

  private bytesInTier(tier: 'STANDARD' | 'INFREQUENT_ACCESS'): number {
    return this.files().reduce((sum, f) => {
      const fileTier = f.storageClass === 'INFREQUENT_ACCESS' ? 'INFREQUENT_ACCESS' : 'STANDARD';
      return fileTier === tier ? sum + (f.sizeBytes || 0) : sum;
    }, 0);
  }

  standardBytes = computed(() => this.bytesInTier('STANDARD'));
  infrequentAccessBytes = computed(() => this.bytesInTier('INFREQUENT_ACCESS'));

  estimatedCost = computed(() => {
    const standardGB = this.standardBytes() / Storage.GB;
    const infrequentGB = this.infrequentAccessBytes() / Storage.GB;
    return standardGB * Storage.STANDARD_RATE + infrequentGB * Storage.INFREQUENT_RATE;
  });

  allStandardCost = computed(() => {
    const allGB = (this.standardBytes() + this.infrequentAccessBytes()) / Storage.GB;
    return allGB * Storage.STANDARD_RATE;
  });

  savings = computed(() => Math.max(this.allStandardCost() - this.estimatedCost(), 0));

  fmt(bytes: number): string {
    return this.storageService.formatFileSize(bytes);
  }

  archiveEligibleDays = signal(30);

  // ==== file class (client gallery vs internal archive) ====
  fileClassOptions: { value: 'client-gallery' | 'internal-archive'; label: string }[] = [
    { value: 'client-gallery', label: 'Client Gallery' },
    { value: 'internal-archive', label: 'Internal Archive' },
  ];
  selectedFileClass = signal<'client-gallery' | 'internal-archive'>('client-gallery');
  isFileClassMenuOpen = signal(false);

  get fileClassLabel(): string {
    return this.fileClassOptions.find((o) => o.value === this.selectedFileClass())?.label ?? 'Client Gallery';
  }

  // ==== upgrade / top-up modal ====
  isUpgradeModalOpen = signal(false);
  activeUpgradeTab = signal<'topup' | 'upgrade'>('topup');
  selectedTopupGB = signal(100);
  selectedPlanTier = signal('Professional');
  paymentReference = signal('');
  isSubmittingUpgrade = signal(false);

  topupOptions: { gb: number; label: string }[] = [
    { gb: 100, label: '100 GB top-up' },
    { gb: 250, label: '250 GB top-up' },
    { gb: 500, label: '500 GB top-up' },
    { gb: 1000, label: '1 TB top-up' },
  ];

  planOptions: { name: string; label: string }[] = [
    { name: 'Starter', label: 'Starter' },
    { name: 'Professional', label: 'Professional' },
    { name: 'Enterprise', label: 'Enterprise' },
  ];

  openUpgradeModal() {
    this.isUpgradeModalOpen.set(true);
  }

  closeUpgradeModal() {
    this.isUpgradeModalOpen.set(false);
  }

  submitUpgradeRequest() {
    const requestType = this.activeUpgradeTab() === 'topup' ? 'topup_block' : 'plan_upgrade';
    const reference = this.paymentReference().trim();

    if (!reference) {
      alert('Please enter the payment transaction reference / UTR.');
      return;
    }

    this.isSubmittingUpgrade.set(true);
    this.storageService
      .submitUpgradeRequest({
        requestType,
        planName: requestType === 'plan_upgrade' ? this.selectedPlanTier() : undefined,
        additionalGB: requestType === 'topup_block' ? this.selectedTopupGB() : 0,
        paymentReference: reference,
      })
      .subscribe({
        next: (response) => {
          console.log('Upgrade request submitted:', response);
          alert('Upgrade request submitted. Our team will confirm shortly.');
          this.isSubmittingUpgrade.set(false);
          this.paymentReference.set('');
          this.closeUpgradeModal();
        },
        error: (error) => {
          console.error('Error submitting upgrade request:', error);
          alert('Failed to submit upgrade request. Please try again.');
          this.isSubmittingUpgrade.set(false);
        },
      });
  }

  // ==== upload form ====
  bookingOptions = signal<BookingOption[]>([]);
  isLoadingBookings = signal(false);
  selectedBookingId = signal<string | null>(null);
  isChooseFileDisabled = computed(() => !this.selectedBookingId());

  rawTypeOptions: FileTypeOption[] = [
    { value: 'raw', label: 'Raw' },
    { value: 'edited', label: 'Edited' },
    { value: 'album', label: 'Album' },
    { value: 'final', label: 'Final' },
    { value: 'other', label: 'Other' },
  ];
  selectedRawType = signal('raw');

mediaTypeOptions: FileTypeOption[] = [
  { value: 'photo', label: 'Photo' },
  { value: 'video', label: 'Video' },
  { value: 'document', label: 'Document' },
  { value: 'archive', label: 'Archive' },
  { value: 'other', label: 'Other' }
];
  selectedMediaType = signal('photo');

  isBookingMenuOpen = signal(false);
  isRawTypeMenuOpen = signal(false);
  isMediaTypeMenuOpen = signal(false);

  // ==== files list + filters ====
  searchTerm = signal('');

categoryOptions: FileTypeOption[] = [
  { value: 'all', label: 'All categories' },
  { value: 'raw', label: 'Raw' },
  { value: 'edited', label: 'Edited' },
  { value: 'album', label: 'Album' },
  { value: 'final', label: 'Final' },
  { value: 'other', label: 'Other' }
];

  selectedCategory = signal('all');
  isCategoryMenuOpen = signal(false);

  files = signal<StorageFile[]>([]);
  isLoadingFiles = signal(false);
  isUploading = signal(false);

  filteredFiles = computed(() => {
    const term = this.searchTerm().trim().toLowerCase();
    const category = this.selectedCategory().toLowerCase();

    return this.files().filter((f) => {
      const matchesTerm =
        !term ||
        (f.name && f.name.toLowerCase().includes(term)) ||
        (f.customer && f.customer.toLowerCase().includes(term)) ||
        (f.bookingId && f.bookingId.toLowerCase().includes(term)) ||
        (f.bookingNumber && f.bookingNumber.toLowerCase().includes(term));

      const fileCategory = (f.category || '').toLowerCase();
      const fileBadge = (f.badge || '').toLowerCase().replace(/\s+/g, '_');

      const matchesCategory =
        category === 'all' ||
        fileCategory === category ||
        fileBadge === category ||
        (category === 'other' && (fileCategory === 'general' || fileBadge === 'other'));

      return matchesTerm && matchesCategory;
    });
  });

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent) {
    if (!this.elementRef.nativeElement.contains(event.target)) {
      this.closeAllMenus();
    }
  }

  closeAllMenus() {
    this.isBookingMenuOpen.set(false);
    this.isRawTypeMenuOpen.set(false);
    this.isMediaTypeMenuOpen.set(false);
    this.isCategoryMenuOpen.set(false);
    this.isFileClassMenuOpen.set(false);
  }

  // ==== dropdown toggles ====
  toggleBookingMenu() {
    const open = !this.isBookingMenuOpen();
    this.closeAllMenus();
    this.isBookingMenuOpen.set(open);
  }

  toggleRawTypeMenu() {
    const open = !this.isRawTypeMenuOpen();
    this.closeAllMenus();
    this.isRawTypeMenuOpen.set(open);
  }

  toggleMediaTypeMenu() {
    const open = !this.isMediaTypeMenuOpen();
    this.closeAllMenus();
    this.isMediaTypeMenuOpen.set(open);
  }

  toggleCategoryMenu() {
    const open = !this.isCategoryMenuOpen();
    this.closeAllMenus();
    this.isCategoryMenuOpen.set(open);
  }

  toggleFileClassMenu() {
    const open = !this.isFileClassMenuOpen();
    this.closeAllMenus();
    this.isFileClassMenuOpen.set(open);
  }

  selectFileClass(value: 'client-gallery' | 'internal-archive') {
    this.selectedFileClass.set(value);
    this.isFileClassMenuOpen.set(false);
  }

  selectBooking(id: string) {
    this.selectedBookingId.set(id);
    this.isBookingMenuOpen.set(false);
  }

  selectRawType(value: string) {
    this.selectedRawType.set(value);
    this.isRawTypeMenuOpen.set(false);
  }

  selectMediaType(value: string) {
    this.selectedMediaType.set(value);
    this.isMediaTypeMenuOpen.set(false);
  }

  selectCategory(value: string) {
    this.selectedCategory.set(value);
    this.isCategoryMenuOpen.set(false);
  }

  get bookingLabel(): string {
    return (
      this.bookingOptions().find((b) => b.id === this.selectedBookingId())?.label ??
      'Select booking'
    );
  }

  get rawTypeLabel(): string {
    return this.rawTypeOptions.find((o) => o.value === this.selectedRawType())?.label ?? 'Raw';
  }

  get mediaTypeLabel(): string {
    return (
      this.mediaTypeOptions.find((o) => o.value === this.selectedMediaType())?.label ?? 'Photo'
    );
  }

  get categoryLabel(): string {
    return (
      this.categoryOptions.find((o) => o.value === this.selectedCategory())?.label ??
      'All categories'
    );
  }

  ngOnInit() {
    this.loadStorageStats();
    this.loadBookings();
    this.loadFiles();
  }

  loadStorageStats() {
    this.isLoadingStats.set(true);
    this.storageService.getStorageStats().subscribe({
      next: (stats) => {
        this.usedBytes.set(stats.usedBytes);
        this.usedLabel.set(stats.usedLabel);
        this.uploadingLabel.set(stats.uploadingLabel);
        this.availableLabel.set(stats.availableLabel);
        this.totalLabel.set(stats.totalLabel);
        this.filesCount.set(stats.filesCount);
        this.isLoadingStats.set(false);
      },
      error: (error) => {
        console.error('Error loading storage stats:', error);
        // Set default values on error
        this.usedLabel.set('0 B');
        this.filesCount.set(0);
        this.isLoadingStats.set(false);
      }
    });
  }

  loadBookings() {
    this.isLoadingBookings.set(true);
    this.storageService.getBookingOptions().subscribe({
      next: (response) => {
        const bookings = response.bookings || [];
        this.bookingOptions.set(bookings.map((booking: any) => ({
          id: booking.id,
          label: `${booking.booking_number} - ${booking.client_name}`,
          clientName: booking.client_name
        })));
        this.isLoadingBookings.set(false);
      },
      error: (error) => {
        console.error('Error loading bookings:', error);
        this.bookingOptions.set([]);
        this.isLoadingBookings.set(false);
      }
    });
  }

  loadFiles() {
    this.isLoadingFiles.set(true);

    this.storageService.getFiles().subscribe({
      next: (response) => {
        this.files.set(response.files || []);
        this.isLoadingFiles.set(false);
      },
      error: (error) => {
        console.error('Error loading files:', error);
        this.files.set([]);
        this.isLoadingFiles.set(false);
      }
    });
  }

  onChooseFile(input: HTMLInputElement) {
    input.value = '';
    input.click();
  }

  onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      const file = input.files[0];
      this.uploadFile(file);
    }
  }

  uploadFile(file: File) {
    if (!this.selectedBookingId()) {
      alert('Please select a booking first');
      return;
    }

    this.isUploading.set(true);
    this.uploadingLabel.set(this.storageService.formatFileSize(file.size));

    const fileData = {
      bookingId: this.selectedBookingId()!,
      fileName: file.name,
      fileType: this.selectedMediaType(),
      fileClass: this.selectedFileClass(),
      category: this.selectedRawType(),
      storagePath: `bookings/${this.selectedBookingId()}/${this.selectedRawType()}/${file.name}`,
      fileSize: file.size,
      status: 'active',
      notes: `Uploaded via storage management`
    };

    this.storageService.uploadFile(fileData, file).subscribe({
      next: (response) => {
        console.log('File uploaded successfully:', response);
        alert('File uploaded successfully!');
        this.loadFiles(); // Refresh file list
        this.loadStorageStats(); // Refresh stats
        this.isUploading.set(false);
        this.uploadingLabel.set('0 B');
      },
      error: (error) => {
        console.error('Error uploading file:', error);
        alert('Failed to upload file. Please try again.');
        this.isUploading.set(false);
        this.uploadingLabel.set('0 B');
      }
    });
  }

  onDownload(file: StorageFile) {
    this.storageService.requestFileDownload(file.id).subscribe({
      next: (response) => {
        if (response.immediate && response.downloadUrl) {
          window.open(response.downloadUrl, '_blank');
          return;
        }
        alert(response.message || 'This file is being restored from archive. Please try again once it is ready.');
        this.loadFiles(); // Refresh file list to reflect restore status
      },
      error: (error) => {
        console.error('Error downloading file:', error);
        alert('Failed to download file. Please try again.');
      }
    });
  }

  onRestore(file: StorageFile) {
    if (confirm(`Restore "${file.name}" from archive?`)) {
      this.storageService.restoreFile(file.id).subscribe({
        next: (response) => {
          console.log('File restore requested:', response);
          alert(response?.message || 'File restore requested. You will be notified when it is ready.');
          this.loadFiles(); // Refresh file list
        },
        error: (error) => {
          console.error('Error restoring file:', error);
          alert('Failed to restore file. Please try again.');
        }
      });
    }
  }
}
