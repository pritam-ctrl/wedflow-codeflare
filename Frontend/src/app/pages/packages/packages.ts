import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NewPackageModal } from './components/new-package-modal/new-package-modal';
import { PackageService, Package } from '../../services/package.service';

interface CrewMember {
  role: string;
  count: number;
}

interface DayCrew {
  dayLabel: string; // "Day 1: Pre-wedding"
  crew: CrewMember[]; // empty hole "No crew defined for this day"
}

interface PaymentTerm {
  label: string; // "Advance", "Balance", "Installment 3"
  percent: number;
  timing: string; // "At Booking", "On Event Day"
}

interface EditorAssignment {
  role: string; // "1x Photo Editor"
  task: string; // "Photo Editing - 7d"
}

interface UIPackage {
  id: string;
  name: string;
  status: 'Active' | 'Inactive';
  durationDays: number;
  price: string;
  description: string;
  crewPerDay: DayCrew[];
  paymentSchedule: PaymentTerm[];
  reminderNote: string;
  editorPlan: EditorAssignment[];
  deliverables: string[];
}

@Component({
  selector: 'app-packages',
  standalone: true,
  imports: [CommonModule, NewPackageModal],
  templateUrl: './packages.html',
  styleUrl: './packages.scss',
})
export class Packages implements OnInit {
  isLoading = false;
  packages: UIPackage[] = [];

  constructor(
    private packageService: PackageService,
    private cdr: ChangeDetectorRef,
  ) {}

  ngOnInit(): void {
    this.loadPackages();
  }

  loadPackages(): void {
    this.isLoading = true;
    this.cdr.detectChanges(); // Show loading state immediately

    this.packageService.getPackages().subscribe({
      next: (response) => {
        const dbPackages = Array.isArray(response?.packages) ? response.packages : [];
        this.packages = dbPackages.length > 0
          ? dbPackages.map(pkg => this.mapDbPackageToUIPackage(pkg))
          : this.mockPackages;
        this.isLoading = false;
        this.cdr.detectChanges(); // Update view with packages
      },
      error: (error) => {
        console.error('Error loading packages:', error);
        this.packages = this.mockPackages;
        this.isLoading = false;
        this.cdr.detectChanges(); // Show error state
      }
    });
  }

  private mapDbPackageToUIPackage(dbPackage: Package): UIPackage {
    return {
      id: dbPackage.id,
      name: dbPackage.name,
      status: dbPackage.status === 'active' ? 'Active' : 'Inactive',
      durationDays: dbPackage.duration_days,
      price: this.formatIndianCurrency(dbPackage.price),
      description: dbPackage.description || '',
      crewPerDay: [],
      paymentSchedule: [],
      reminderNote: dbPackage.reminder_day
        ? `Reminders use Day ${dbPackage.reminder_day}; crew details mail: ${dbPackage.reminder_email_days} days before each event day.`
        : '',
      editorPlan: [],
      deliverables: dbPackage.deliverables || [],
    };
  }

  // Keep existing mock data as fallback for now
  mockPackages: UIPackage[] = [
    {
      id: '1',
      name: 'ROYAL WEDDING PACKAGE',
      status: 'Active',
      durationDays: 5,
      price: '₹2,20,000',
      description:
        '4 Days Full Coverage + Pre-wedding (Photo & Video – Both Sides) Drone Shoot (Wedding + Pre-wedding)',
      crewPerDay: [
        {
          dayLabel: 'Day 1: Pre-wedding',
          crew: [
            { role: 'Photographer', count: 1 },
            { role: 'Videographer', count: 1 },
            { role: 'Drone Operator', count: 1 },
          ],
        },
        {
          dayLabel: 'Day 2: Mehendi/Aiburobhat',
          crew: [
            { role: 'Photographer', count: 1 },
            { role: 'Videographer', count: 1 },
          ],
        },
        {
          dayLabel: 'Day 3: Wedding',
          crew: [
            { role: 'Photographer', count: 3 },
            { role: 'Cinematographer', count: 2 },
            { role: 'Drone Operator', count: 1 },
          ],
        },
        {
          dayLabel: 'Day 4: Vidai/Baran',
          crew: [
            { role: 'Photographer', count: 1 },
            { role: 'Cinematographer', count: 1 },
          ],
        },
        {
          dayLabel: 'Day 5: Reception',
          crew: [
            { role: 'Photographer', count: 2 },
            { role: 'Cinematographer', count: 1 },
          ],
        },
      ],
      paymentSchedule: [
        { label: 'Advance', percent: 50, timing: 'At Booking' },
        { label: 'On Event Day', percent: 40, timing: 'On Event Day' },
        { label: 'On Final Delivery', percent: 10, timing: 'Days After Event' },
      ],
      reminderNote: 'Reminders use Day 3; crew details mail: 7 days before each event day.',
      editorPlan: [],
      deliverables: [
        '2 Royal Look Albums (12×36 size) (60 Pages per Album)',
        '180–200 Edited Photos',
        '2 Mini Albums',
      ],
    },
    {
      id: '2',
      name: 'EXCLUSIVE WEDDING PACKAGE',
      status: 'Active',
      durationDays: 4,
      price: '₹15,00,000',
      description: '3 Days Coverage + Pre-wedding (Photo & Video Both Sides)',
      crewPerDay: [
        {
          dayLabel: 'Day 1: Pre-wedding',
          crew: [
            { role: 'Photographer', count: 1 },
            { role: 'Cinematographer', count: 1 },
            { role: 'Drone Operator', count: 1 },
          ],
        },
        {
          dayLabel: 'Day 2: Wedding',
          crew: [
            { role: 'Photographer', count: 3 },
            { role: 'Cinematographer', count: 2 },
          ],
        },
        {
          dayLabel: 'Day 3: Vidai/Baran',
          crew: [
            { role: 'Photographer', count: 1 },
            { role: 'Cinematographer', count: 1 },
          ],
        },
        {
          dayLabel: 'Day 4: Reception',
          crew: [
            { role: 'Photographer', count: 2 },
            { role: 'Cinematographer', count: 1 },
          ],
        },
      ],
      paymentSchedule: [
        { label: 'Advance', percent: 50, timing: 'At Booking' },
        { label: 'On Event', percent: 40, timing: 'On Event Day' },
        { label: 'On Final Delivery', percent: 10, timing: 'Days After Event' },
      ],
      reminderNote: 'Reminders use Day 2; crew details mail: 7 days before each event day.',
      editorPlan: [],
      deliverables: [
        '2 Exclusive Albums (12×36 size) (60 Pages per Album)',
        '180–200 Edited Photos',
        '2 Mini Albums',
      ],
    },
    {
      id: '3',
      name: 'STANDARD WEDDING PACKAGE',
      status: 'Active',
      durationDays: 3,
      price: '₹1,00,000',
      description: '3 Days Wedding Coverage',
      crewPerDay: [
        {
          dayLabel: 'Day 1: Wedding',
          crew: [
            { role: 'Photographer', count: 2 },
            { role: 'Cinematographer', count: 1 },
          ],
        },
        {
          dayLabel: 'Day 2: Vidai/Baran',
          crew: [
            { role: 'Photographer', count: 1 },
            { role: 'Cinematographer', count: 1 },
          ],
        },
        {
          dayLabel: 'Day 3: Reception',
          crew: [
            { role: 'Photographer', count: 2 },
            { role: 'Cinematographer', count: 1 },
          ],
        },
      ],
      paymentSchedule: [
        { label: 'Advance', percent: 50, timing: 'At Booking' },
        { label: 'On Event Day', percent: 40, timing: 'On Event Day' },
        { label: 'On Final Delivery', percent: 10, timing: 'Days After Event' },
      ],
      reminderNote: 'Reminders use Day 1; crew details mail: 7 days before each event day.',
      editorPlan: [],
      deliverables: [
        '2 Standard Plus Albums (12×36 size) (40 Pages per Album)',
        '120–130 Edited Photos for each album',
        '4K Wedding Film (20–25 mins)',
      ],
    },
    {
      id: '4',
      name: 'BASIC PRE-WEDDING PACKAGE',
      status: 'Active',
      durationDays: 1,
      price: '₹20,000',
      description: '1 DAY SHOOT 2/3 LOCATION PHOTO + VIDEO COVERAGE',
      crewPerDay: [
        {
          dayLabel: 'Day 1: Pre-Wedding',
          crew: [
            { role: 'Photographer', count: 1 },
            { role: 'Cinematographer', count: 1 },
          ],
        },
      ],
      paymentSchedule: [
        { label: 'Advance', percent: 60, timing: 'At Booking' },
        { label: 'Advance', percent: 40, timing: 'On Event Day' },
        { label: 'On Final Delivery', percent: 10, timing: 'days After Event' },
      ],
      reminderNote: 'Reminders use Day 1; crew details mail: 2 days before each event day.',
      editorPlan: [],
      deliverables: [
        '25–30 Special Edited Photos',
        '1 Cinematic Teaser (3–4 mins)',
        'All Raw Photos (Soft Copy)',
      ],
    },
    {
      id: '5',
      name: 'PREMIUM PRE-WEDDING PACKAGE',
      status: 'Active',
      durationDays: 2,
      price: '₹35,000',
      description: '2 DAYS SHOOT MULTIPLE LOCATIONS',
      crewPerDay: [
        {
          dayLabel: 'Day 1: Pre-Wedding',
          crew: [
            { role: 'Photographer', count: 1 },
            { role: 'Cinematographer', count: 1 },
            { role: 'Drone Operator', count: 1 },
          ],
        },
        {
          dayLabel: 'Day 2: Pre-Wedding',
          crew: [
            { role: 'Photographer', count: 1 },
            { role: 'Cinematographer', count: 1 },
            { role: 'Drone Operator', count: 1 },
          ],
        },
      ],
      paymentSchedule: [
        { label: 'Advance', percent: 60, timing: 'At Booking' },
        { label: 'Advance', percent: 40, timing: 'On Event Day' },
        { label: 'On Final Delivery', percent: 10, timing: 'days After Event' },
      ],
      reminderNote: 'Reminders use Day 1; crew details mail: 5 days before each event day.',
      editorPlan: [],
      deliverables: [
        '40–50 Edited Photos',
        '1 Cinematic Pre-Wedding Film (3–4 mins)',
        'Teaser (1 min)',
      ],
    },
    {
      id: '6',
      name: 'ABC PACKAGE',
      status: 'Active',
      durationDays: 2,
      price: '₹50,000',
      description: 'Full Package',
      crewPerDay: [
        {
          dayLabel: 'Day 1: Wedding',
          crew: [
            { role: 'Photographer', count: 1 },
            { role: 'Cinematographer', count: 1 },
          ],
        },
        {
          dayLabel: 'Day 2: Reception',
          crew: [
            { role: 'Photographer', count: 1 },
            { role: 'Cinematographer', count: 1 },
          ],
        },
      ],
      paymentSchedule: [
        { label: 'Advance', percent: 50, timing: 'At Booking' },
        { label: 'On Final Delivery', percent: 50, timing: 'Days After Event' },
      ],
      reminderNote: 'Reminders use Day 1; crew details mail: 3 days before each event day.',
      editorPlan: [],
      deliverables: ['Video'],
    },
    {
      id: '7',
      name: 'ROYAL WEDDING PACKAGE',
      status: 'Active',
      durationDays: 3,
      price: '₹35,000',
      description:
        'Complete Royal Wedding Coverage including Pre-Wedding Shoot, Haldi Ceremony, Mehendi.',
      crewPerDay: [
        {
          dayLabel: 'Day 1: Mehendi',
          crew: [
            { role: 'Photographer', count: 2 },
            { role: 'Cinematographer', count: 2 },
          ],
        },
        {
          dayLabel: 'Day 2: Wedding',
          crew: [
            { role: 'Photographer', count: 2 },
            { role: 'Cinematographer', count: 2 },
            { role: 'Drone Operator', count: 1 },
          ],
        },
        {
          dayLabel: 'Day 3: Reception',
          crew: [{ role: 'Photographer', count: 2 }],
        },
      ],
      paymentSchedule: [
        { label: 'Advance', percent: 30, timing: 'At Booking' },
        { label: 'Advance', percent: 30, timing: 'On Event Day' },
        { label: 'Advance', percent: 30, timing: 'Days After Event 1d' },
        { label: 'Advance', percent: 100, timing: 'At Booking' },
      ],
      reminderNote: 'Reminders use Day 1; crew details mail: 3 days before each event day.',
      editorPlan: [
        { role: '1x videographer', task: 'video Editing - 7d' },
        { role: '1x photo Editor', task: 'photo Editing - 7d' },
      ],
      deliverables: [
        'Pre-Wedding Photoshoot (1 Day)',
        '100+ Professionally Edited Photos',
        '15–20 Minute Cinematic Wedding Film',
      ],
    },
    {
      id: '8',
      name: 'ULTIMATE WEDDING PACKAGE',
      status: 'Active',
      durationDays: 4,
      price: '₹3,50,000',
      description: 'Wedding Package',
      crewPerDay: [
        {
          dayLabel: 'Day 1: Sangeet/Haldi',
          crew: [
            { role: 'Photographer', count: 2 },
            { role: 'Cinematographer', count: 2 },
            { role: 'Drone Operator', count: 1 },
          ],
        },
        {
          dayLabel: 'Day 2: Mehendi',
          crew: [
            { role: 'Photographer', count: 2 },
            { role: 'Photo Editor', count: 2 },
          ],
        },
        {
          dayLabel: 'Day 3: Wedding',
          crew: [{ role: 'Photographer', count: 3 }],
        },
        {
          dayLabel: 'Day 4: Reception',
          crew: [{ role: 'Photographer', count: 2 }],
        },
      ],
      paymentSchedule: [
        { label: 'Advance', percent: 30, timing: 'At Booking' },
        { label: 'Advance', percent: 20, timing: 'On Event Day' },
        { label: 'Advance', percent: 50, timing: 'On Final Delivery' },
      ],
      reminderNote: 'Reminders use Day 1; crew details mail: 3 days before each event day.',
      editorPlan: [
        { role: '1x Photo Editor', task: 'video Editing - 7d' },
        { role: '1x photo Editor', task: 'photo Editing - 7d' },
      ],
      deliverables: ['ghghgh'],
    },
    {
      id: '9',
      name: 'OM PHOTOGRAPHY PREMIUM PACKAGE',
      status: 'Active',
      durationDays: 5,
      price: '₹76,000',
      description: 'sdgfhdf',
      crewPerDay: [
        {
          dayLabel: 'Day 1: Wedding',
          crew: [],
        },
        {
          dayLabel: 'Day 2: Haldi',
          crew: [],
        },
        {
          dayLabel: 'Day 3: Wedding',
          crew: [],
        },
        {
          dayLabel: 'Day 4: Reception',
          crew: [],
        },
      ],
      paymentSchedule: [
        { label: 'Advance', percent: 20, timing: 'At Booking' },
        { label: 'Balance', percent: 20, timing: 'On Event Day' },
        { label: 'Installment 2', percent: 60, timing: 'On Final Delivery' },
      ],
      reminderNote: 'Reminders use Day 1; crew details mail: 3 days before each event day.',
      editorPlan: [
        { role: '1x Photographar', task: 'Photo Editing - 7d' },
        { role: '1x Video Editor', task: 'photo Editing - 7d' },
      ],
      deliverables: ['heheheww'],
    },
  ];

  // ----- Deliverables: prothom 3 ta dekhabe, baki count-e "+X more..." -----
  visibleDeliverables(pkg: UIPackage): string[] {
    return pkg.deliverables.slice(0, 3);
  }

  remainingCount(pkg: UIPackage): number {
    return Math.max(pkg.deliverables.length - 3, 0);
  }

  showModal = false;
  editMode = false;
  editingPackage: UIPackage | null = null;

  onNewPackage(): void {
    this.editMode = false;
    this.editingPackage = null;
    this.showModal = true;
  }

  onEdit(pkg: UIPackage): void {
    this.editMode = true;
    this.editingPackage = pkg;
    this.showModal = true;
  }

  onDelete(pkg: UIPackage): void {
    if (!confirm(`Are you sure you want to delete ${pkg.name}?`)) {
      return;
    }

    this.packageService.deletePackage(pkg.id).subscribe({
      next: (response) => {
        this.packages = this.packages.filter((p) => p.id !== pkg.id);
        this.cdr.detectChanges();
        this.loadPackages();
      },
      error: (error) => {
        console.error('Error deleting package:', error);
      }
    });
  }

  onPackageCreated(formValue: any) {
    const packageName = (formValue.name || '').trim();
    
    if (!packageName) {
      alert('Package name is required.');
      return;
    }

    if (this.editMode && this.editingPackage) {
      // Update existing package
      const updateRequest = {
        name: packageName,
        durationDays: Number(formValue.durationDays),
        price: parseFloat(formValue.price.toString()),
        description: formValue.description,
        status: formValue.availability ? 'active' : 'inactive',
        reminderDay: formValue.reminderReferenceDay,
        reminderEmailDays: formValue.crewMailBeforeEvent,
        deliverables: this.toDeliverables(formValue.deliverables)
      };

      this.packageService.updatePackage(this.editingPackage.id, updateRequest).subscribe({
        next: (response) => {
          const updatedPackage = this.mapDbPackageToUIPackage(response.package);
          this.packages = this.packages.map(p => p.id === this.editingPackage?.id ? updatedPackage : p);
          this.showModal = false;
          this.editMode = false;
          this.editingPackage = null;
          this.cdr.detectChanges();
          this.loadPackages();
        },
        error: (error) => {
          console.error('Error updating package:', error);
          const message = error?.error?.error || error?.message || 'Failed to update package.';
          alert(message);
        }
      });
    } else {
      // Create new package
      const isDuplicate = this.packages.some(pkg => pkg.name.toLowerCase() === packageName.toLowerCase());

      if (isDuplicate) {
        alert(`Package "${packageName}" already exists in this workspace. Please use a unique name.`);
        return;
      }

      const createRequest = {
        name: packageName,
        durationDays: Number(formValue.durationDays),
        price: parseFloat(formValue.price.toString()),
        description: formValue.description,
        status: formValue.availability ? 'active' : 'inactive',
        reminderDay: formValue.reminderReferenceDay,
        reminderEmailDays: formValue.crewMailBeforeEvent,
        deliverables: this.toDeliverables(formValue.deliverables)
      };

      this.packageService.createPackage(createRequest).subscribe({
        next: (response) => {
          const newPackage = this.mapDbPackageToUIPackage(response.package);
          this.packages = [...this.packages, newPackage];
          this.showModal = false;
          this.cdr.detectChanges();
          this.loadPackages();
        },
        error: (error) => {
          console.error('Error creating package:', error);
          const message = error?.error?.error || error?.message || 'Failed to create package.';
          alert(message);
        }
      });
    }
  }

  private mapFormToPackage(formValue: any): UIPackage {
    return {
      id: (this.packages.length + 1).toString(),
      name: formValue.name,
      status: formValue.availability ? 'Active' : 'Inactive',
      durationDays: formValue.durationDays,
      price: this.formatIndianCurrency(formValue.price),
      description: formValue.description,

      crewPerDay: formValue.crewDays.map((day: any) => ({
        dayLabel: `Day ${day.day}: ${day.eventLabel}`,
        crew: day.roles.map((r: any) => ({ role: r.roleName, count: r.count })),
      })),

      paymentSchedule: formValue.paymentRows.map((row: any) => ({
        label: row.label,
        percent: row.percent,
        timing: row.whenDue,
      })),

      reminderNote: `Reminders use Day ${formValue.reminderReferenceDay}; crew details mail: ${formValue.crewMailBeforeEvent} days before each event day.`,

      // eikhanei Editor Plan-er logic — jodi kono row-e role/task select kora
      // thake shudhu tokhoni entry banabe, nahole editorPlan: [] thakবে
      // r card-e "Editor Plan" section *ngIf diye auto-hide hoye jaবে
      editorPlan: formValue.editorRows
        .filter((row: any) => row.editorRole && row.taskType && row.qty > 0)
        .map((row: any) => ({
          role: `${row.qty}x ${row.editorRole}`,
          task: `${row.taskType} - ${row.days}d`,
        })),

      deliverables: formValue.deliverables
        .split('\n')
        .map((d: string) => d.trim())
        .filter((d: string) => d.length > 0),
    };
  }

  private formatIndianCurrency(value: number): string {
    return '₹' + Number(value).toLocaleString('en-IN');
  }

  private toDeliverables(value: string): string[] {
    return (value || '').split('\n').map(item => item.trim()).filter(Boolean);
  }
}
