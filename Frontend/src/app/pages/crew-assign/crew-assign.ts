import { Component, OnInit, NgZone, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { Observable, forkJoin } from 'rxjs';
import { BookingService, Booking, BookingResponse } from '../../services/booking.service';
import {
  CrewAssignmentService,
  CrewAssignment,
  Staff,
  CreateCrewAssignmentRequest,
} from '../../services/crew-assignment.service';
import { Auth } from '../../services/auth';

interface CrewMember {
  id: string;
  name: string;
  shift: string;
}

interface RoleAssignment {
  role: string;
  required: number;
  assigned: CrewMember[];
}

interface EventStage {
  id: string;
  booking_event_id?: string;
  name: string;
  date: string;
  rawDate: string;
  venue: string;
  done: boolean;
  overdue: boolean;
  filled: boolean;
  roles: RoleAssignment[];
}

interface BookingQueueItem {
  id: string;
  clientName: string;
  packageName: string;
  date: string;
  venue: string;
  pendingCount: number;
  overdue: boolean;
  stages: EventStage[];
}

interface StaffWithAvailability extends Staff {
  isAvailable: boolean;
  isRoleMatch?: boolean;
  existingAssignments: number;
  conflictingDates: string[];
}

@Component({
  selector: 'app-crew-assign',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './crew-assign.html',
  styleUrl: './crew-assign.scss',
})
export class CrewAssign implements OnInit {
  pendingRoles = 0;
  filledPercent = 0;
  totalBookings = 0;

  searchTerm = '';
  roleFilter = 'all';
  pendingOnly = true;
  dateFrom = '';
  dateTo = '';
  eventFilter = 'all';

  bookingQueue: BookingQueueItem[] = [];
  selectedBookingId: string | null = null;
  allStaff: Staff[] = [];
  crewAssignments: CrewAssignment[] = [];
  isLoading = false;
  error: string | null = null;
  showAssignModal = false;
  selectedStage: EventStage | null = null;
  selectedRole: RoleAssignment | null = null;
  memberToReassign: CrewMember | null = null;
  availableStaffForRole: StaffWithAvailability[] = [];

  constructor(
    private http: HttpClient,
    private bookingService: BookingService,
    private crewAssignmentService: CrewAssignmentService,
    private authService: Auth,
    private ngZone: NgZone,
    private cdr: ChangeDetectorRef,
  ) {}

  ngOnInit(): void {
    this.loadCrewAssignments();
  }

  loadCrewAssignments(): void {
    this.isLoading = true;
    this.error = null;

    if (!this.isAuthenticated()) {
      this.error = 'You need to be logged in to access crew assignments. Please log in and try again.';
      this.isLoading = false;
      return;
    }

    forkJoin({
      bookings: this.bookingService.getBookings(),
      crew: this.crewAssignmentService.getCrewAssignments(),
      staff: this.crewAssignmentService.getStaff()
    }).subscribe({
      next: ({ bookings, crew, staff }) => {
        try {
          const staffArray = staff.staff || staff.users || [];
          this.allStaff = staffArray.map((s: any) => ({
            id: s.id,
            name: s.staff_name || s.name || `${s.first_name || ''} ${s.last_name || ''}`.trim(),
            email: s.email,
            phone: s.phone_number || s.phone,
            role: s.role,
            availability: s.availability || 'available',
            status: s.status || (s.is_active ? 'active' : 'inactive'),
            staff_name: s.staff_name,
            first_name: s.first_name,
            last_name: s.last_name,
            is_active: s.is_active
          }));

          this.crewAssignments = crew.crewAssignments || [];
          this.bookingQueue = this.transformBookingsToQueue(bookings.bookings || []);
          this.updateStats();

          if (this.selectedBookingId) {
            const exists = this.bookingQueue.some(b => b.id === this.selectedBookingId);
            if (!exists) {
              this.selectedBookingId = this.bookingQueue.length > 0 ? this.bookingQueue[0].id : null;
            }
          } else if (this.bookingQueue.length > 0) {
            this.selectedBookingId = this.bookingQueue[0].id;
          }

          this.isLoading = false;
          this.cdr.detectChanges();
        } catch (processingError) {
          console.error('Error processing data:', processingError);
          this.error = `Error processing data: ${processingError instanceof Error ? processingError.message : 'Unknown error'}`;
          this.isLoading = false;
          this.cdr.detectChanges();
        }
      },
      error: (err) => {
        console.error('Error loading crew assignment data:', err);
        this.error = `Failed to load data: ${err.message || err.status || 'Unknown error'}`;
        this.isLoading = false;
        this.cdr.detectChanges();
      }
    });
  }

  isAuthenticated(): boolean {
    return this.authService.isAuthenticated();
  }

  transformBookingsToQueue(bookings: Booking[]): BookingQueueItem[] {
    try {
      return bookings.map((booking) => {
        const eventStages = this.extractEventStages(booking);
        const pendingCount = this.calculatePendingCount(eventStages);
        const isOverdue = this.isBookingOverdue(booking);

        return {
          id: booking.id,
          clientName: booking.client_name || 'Unknown Client',
          packageName: booking.package_name || 'Unknown Package',
          date: this.formatDate(booking.booking_date),
          venue: booking.venue || 'Unknown Venue',
          pendingCount,
          overdue: isOverdue,
          stages: eventStages,
        };
      });
    } catch (error) {
      console.error('Error transforming bookings to queue:', error);
      return [];
    }
  }

  normalizeDate(dateStr: string | null | undefined): string {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr.substring(0, 10);
    return d.toISOString().split('T')[0];
  }

  extractEventStages(booking: Booking): EventStage[] {
    try {
      const eventDays = booking.event_days || [];
      
      const assignments = this.crewAssignments.filter((ca) => {
        if (ca.booking_event_id) {
          return eventDays.some((ed) => ed.id === ca.booking_event_id);
        }
        return eventDays.some((ed) => {
          const eventDateMatch = this.normalizeDate(ed.event_date) === this.normalizeDate(ca.event_date);
          const nameMatch = ed.event_name?.toLowerCase() === ca.event_name?.toLowerCase();
          return eventDateMatch && nameMatch;
        });
      });

      return eventDays.map((eventDay) => {
        const eventAssignments = assignments.filter((ca) => {
          if (ca.booking_event_id) {
            return ca.booking_event_id === eventDay.id;
          }
          const eventDateMatch = this.normalizeDate(eventDay.event_date) === this.normalizeDate(ca.event_date);
          const nameMatch = eventDay.event_name?.toLowerCase() === ca.event_name?.toLowerCase();
          return eventDateMatch && nameMatch;
        });

        const roleGroups = this.groupAssignmentsByRole(eventAssignments);
        const crewPlan = this.getCrewPlanForEvent(booking, eventDay);

        const roles = Object.keys(roleGroups).map((role) => {
          const crewRequirement = crewPlan?.roles?.find((r: any) => r.role === role);
          const required = crewRequirement?.quantity || roleGroups[role].length;
          const assigned = roleGroups[role].map((member) => ({
            id: member.staff_id,
            name: member.staff_name,
            shift: this.formatShift(member.start_time, member.end_time),
          }));

          return {
            role,
            required,
            assigned,
          };
        });

        if (roles.length === 0 && crewPlan?.roles) {
          crewPlan.roles.forEach((planRole: any) => {
            roles.push({
              role: planRole.role,
              required: planRole.quantity,
              assigned: [],
            });
          });
        }

        const isFilled = roles.length > 0 && roles.every((r) => r.assigned.length >= r.required);
        const isOverdue = eventDay.event_date ? this.isEventOverdue(eventDay.event_date) : false;
        const isDone = eventDay.event_date ? this.isEventDone(eventDay.event_date) : false;

        return {
          id: `${booking.id}-${eventDay.event_name}-${eventDay.event_date || 'tbd'}`,
          booking_event_id: eventDay.id,
          name: eventDay.event_name,
          date: eventDay.event_date ? this.formatDate(eventDay.event_date) : 'Date TBD',
          rawDate: eventDay.event_date || '',
          venue: eventDay.venue || booking.venue || 'Unknown',
          done: isDone,
          overdue: isOverdue,
          filled: isFilled,
          roles,
        };
      });
    } catch (error) {
      console.error('Error extracting event stages for booking:', booking.id, error);
      return [];
    }
  }

  groupAssignmentsByRole(assignments: CrewAssignment[]): Record<string, CrewAssignment[]> {
    return assignments.reduce(
      (groups, assignment) => {
        const role = assignment.assigned_role;
        if (!groups[role]) {
          groups[role] = [];
        }
        groups[role].push(assignment);
        return groups;
      },
      {} as Record<string, CrewAssignment[]>,
    );
  }

  getCrewPlanForEvent(booking: Booking, eventDay: any): any {
    const crewPlan = booking.package_crew_plan || [];
    if (!crewPlan || crewPlan.length === 0) return null;
    
    let matchingDay = crewPlan.find(
      (day: any) => day.event_type && day.event_type.toLowerCase() === eventDay.event_name.toLowerCase(),
    );
    
    if (!matchingDay) {
      matchingDay = crewPlan.find((day: any) => 
        day.event_type && (
          day.event_type.toLowerCase().includes(eventDay.event_name.toLowerCase()) ||
          eventDay.event_name.toLowerCase().includes(day.event_type.toLowerCase())
        )
      );
    }

    if (!matchingDay && crewPlan.length === 1) {
      matchingDay = crewPlan[0];
    }
    
    return matchingDay;
  }

  hasUnconfiguredPlan(booking: BookingQueueItem | undefined): boolean {
    if (!booking || booking.stages.length === 0) return true;
    return booking.stages.some(s => s.roles.length === 0);
  }

  calculatePendingCount(stages: EventStage[]): number {
    return stages.reduce((total, stage) => {
      return (
        total +
        stage.roles.reduce((roleTotal, role) => {
          return roleTotal + Math.max(0, role.required - role.assigned.length);
        }, 0)
      );
    }, 0);
  }

  isBookingOverdue(booking: Booking): boolean {
    const bookingDate = new Date(booking.booking_date);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return bookingDate < today;
  }

  isEventOverdue(eventDate: string): boolean {
    const date = new Date(eventDate);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return date < today;
  }

  isEventDone(eventDate: string): boolean {
    const date = new Date(eventDate);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return date < today;
  }

  formatDate(dateStr: string): string {
    if (!dateStr) return 'Unknown Date';
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  formatShift(startTime: string | null, endTime: string | null): string {
    if (!startTime && !endTime) return 'Full Day';
    if (startTime && endTime) {
      return `${this.formatTime(startTime)} - ${this.formatTime(endTime)}`;
    }
    if (startTime) return `${this.formatTime(startTime)} onwards`;
    if (endTime) return `Until ${this.formatTime(endTime)}`;
    return 'Full Day';
  }

  formatTime(timeStr: string): string {
    const [hours, minutes] = timeStr.split(':');
    const date = new Date();
    date.setHours(parseInt(hours), parseInt(minutes));
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  }

  updateStats(): void {
    try {
      this.totalBookings = this.bookingQueue.length;
      
      this.pendingRoles = this.bookingQueue.reduce(
        (total, booking) => total + booking.pendingCount,
        0,
      );

      const totalRequired = this.bookingQueue.reduce((total, booking) => {
        return (
          total +
          booking.stages.reduce((stageTotal, stage) => {
            return stageTotal + stage.roles.reduce((roleTotal, role) => roleTotal + role.required, 0);
          }, 0)
        );
      }, 0);

      const totalAssigned = this.bookingQueue.reduce((total, booking) => {
        return (
          total +
          booking.stages.reduce((stageTotal, stage) => {
            return (
              stageTotal +
              stage.roles.reduce((roleTotal, role) => roleTotal + role.assigned.length, 0)
            );
          }, 0)
        );
      }, 0);

      this.filledPercent =
        totalRequired === 0 ? 0 : Math.round((totalAssigned / totalRequired) * 100);
    } catch (error) {
      console.error('Error updating stats:', error);
      this.totalBookings = this.bookingQueue.length;
      this.pendingRoles = 0;
      this.filledPercent = 0;
    }
  }

  get selectedBooking(): BookingQueueItem | undefined {
    return this.bookingQueue.find((b) => b.id === this.selectedBookingId);
  }

  get filteredQueue(): BookingQueueItem[] {
    try {
      const term = this.searchTerm.trim().toLowerCase();
      return this.bookingQueue.filter((b) => {
        const matchesSearch =
          !term ||
          b.clientName.toLowerCase().includes(term) ||
          b.packageName.toLowerCase().includes(term) ||
          b.venue.toLowerCase().includes(term);

        const matchesPending = !this.pendingOnly || b.pendingCount > 0;

        let matchesEvent = true;
        if (this.eventFilter !== 'all') {
          matchesEvent = b.stages.some(stage => stage.name === this.eventFilter);
        }

        let matchesDateRange = true;
        if (this.dateFrom || this.dateTo) {
          const bookingDate = new Date(b.date);
          if (this.dateFrom) {
            const fromDate = this.parseDateInput(this.dateFrom);
            if (fromDate && bookingDate < fromDate) matchesDateRange = false;
          }
          if (this.dateTo) {
            const toDate = this.parseDateInput(this.dateTo);
            if (toDate && bookingDate > toDate) matchesDateRange = false;
          }
        }

        return matchesSearch && matchesPending && matchesEvent && matchesDateRange;
      }).sort((a, b) => {
        const dateA = new Date(a.date);
        const dateB = new Date(b.date);
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const aOverdue = dateA < today;
        const bOverdue = dateB < today;

        if (aOverdue && !bOverdue) return -1;
        if (!aOverdue && bOverdue) return 1;
        
        return dateA.getTime() - dateB.getTime();
      });
    } catch (error) {
      console.error('Error filtering queue:', error);
      return this.bookingQueue;
    }
  }

  parseDateInput(dateStr: string): Date | null {
    if (!dateStr) return null;
    const clean = dateStr.trim();
    if (clean.includes('-')) {
      const parts = clean.split('-');
      if (parts.length === 3) {
        if (parts[0].length === 4) {
          return new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
        } else {
          return new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
        }
      }
    } else if (clean.includes('/')) {
      const parts = clean.split('/');
      if (parts.length === 3) {
        return new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
      }
    }
    const d = new Date(clean);
    return isNaN(d.getTime()) ? null : d;
  }

  get selectedRoleCards() {
    try {
      if (!this.selectedBooking) return [];
      return this.selectedBooking.stages.flatMap((stage) =>
        stage.roles.map((role) => ({
          stage,
          role,
          pending: role.required - role.assigned.length,
        })),
      );
    } catch (error) {
      console.error('Error getting selected role cards:', error);
      return [];
    }
  }
  // ---------- Right panel (redesign) ----------
stageFilter: 'all' | 'pending' | 'filled' = 'all';

setStageFilter(filter: 'all' | 'pending' | 'filled'): void {
  this.stageFilter = filter;
}

get visibleStages(): EventStage[] {
  const booking = this.selectedBooking;
  if (!booking) return [];
  if (this.stageFilter === 'pending') {
    return booking.stages.filter((s) => this.stagePendingCount(s) > 0);
  }
  if (this.stageFilter === 'filled') {
    return booking.stages.filter((s) => this.isStageFilled(s));
  }
  return booking.stages;
}

stagePendingCount(stage: EventStage): number {
  return stage.roles.reduce((t, r) => t + Math.max(0, r.required - r.assigned.length), 0);
}

isStageFilled(stage: EventStage): boolean {
  return stage.roles.length > 0 && this.stagePendingCount(stage) === 0;
}

pendingStageCount(b: BookingQueueItem): number {
  return b.stages.filter((s) => this.stagePendingCount(s) > 0).length;
}

filledStageCount(b: BookingQueueItem): number {
  return b.stages.filter((s) => this.isStageFilled(s)).length;
}

overdueStageCount(b: BookingQueueItem): number {
  return b.stages.filter((s) => s.overdue).length;
}

bookingSlots(b: BookingQueueItem): { required: number; assigned: number } {
  let required = 0;
  let assigned = 0;
  b.stages.forEach((s) =>
    s.roles.forEach((r) => {
      required += r.required;
      assigned += Math.min(r.assigned.length, r.required);
    }),
  );
  return { required, assigned };
}

slotSegments(b: BookingQueueItem): boolean[] {
  const { required, assigned } = this.bookingSlots(b);
  return Array.from({ length: required }, (_, i) => i < assigned);
}

roleDots(role: RoleAssignment): boolean[] {
  const total = Math.max(role.required, role.assigned.length);
  return Array.from({ length: total }, (_, i) => i < role.assigned.length);
}

openSlots(role: RoleAssignment): number[] {
  return Array.from({ length: Math.max(0, role.required - role.assigned.length) }, (_, i) => i);
}

  get eventTypes(): string[] {
    const allEvents = new Set<string>();
    this.bookingQueue.forEach(booking => {
      booking.stages.forEach(stage => {
        allEvents.add(stage.name);
      });
    });
    return Array.from(allEvents).sort();
  }

  selectBooking(id: string): void {
  this.selectedBookingId = id;
  this.stageFilter = 'all';
}

  overallProgressPercent(booking: BookingQueueItem): number {
    const total = booking.stages.reduce(
      (sum, s) => sum + s.roles.reduce((rSum, r) => rSum + r.required, 0),
      0,
    );
    const filled = booking.stages.reduce(
      (sum, s) => sum + s.roles.reduce((rSum, r) => rSum + r.assigned.length, 0),
      0,
    );
    return total === 0 ? 0 : Math.round((filled / total) * 100);
  }

  daysLeft(dateStr: string): number {
    const eventDate = new Date(dateStr);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    eventDate.setHours(0, 0, 0, 0);
    const diffMs = eventDate.getTime() - today.getTime();
    return Math.round(diffMs / (1000 * 60 * 60 * 24));
  }

  onRemoveCrew(stage: EventStage, role: RoleAssignment, member: CrewMember): void {
    const assignment = this.crewAssignments.find((ca) => {
      if (ca.staff_id !== member.id) return false;
      if (ca.assigned_role.toLowerCase() !== role.role.toLowerCase()) return false;
      if (ca.booking_event_id && stage.booking_event_id) {
        return ca.booking_event_id === stage.booking_event_id;
      }
      const isDateMatch = this.normalizeDate(ca.event_date) === this.normalizeDate(stage.rawDate);
      const isNameMatch = ca.event_name?.toLowerCase() === stage.name.toLowerCase();
      return isDateMatch && isNameMatch;
    });

    if (assignment) {
      this.crewAssignmentService.deleteCrewAssignment(assignment.id).subscribe({
        next: () => {
          this.loadCrewAssignments();
        },
        error: (err) => {
          console.error('Error removing crew assignment:', err);
          this.error = 'Failed to remove crew assignment';
        },
      });
    } else {
      console.error('Could not find crew assignment to remove for member:', member);
    }
  }

  getEventStageId(assignment: CrewAssignment): string {
    const booking = this.bookingQueue.find((b) =>
      b.stages.some(
        (s) =>
          s.name === assignment.event_name && this.normalizeDate(s.rawDate) === this.normalizeDate(assignment.event_date),
      ),
    );
    if (booking) {
      const stage = booking.stages.find(
        (s) =>
          s.name === assignment.event_name && this.normalizeDate(s.rawDate) === this.normalizeDate(assignment.event_date),
      );
      return stage?.id || '';
    }
    return '';
  }

  onAssignRole(stage: EventStage, role: RoleAssignment): void {
    this.memberToReassign = null;
    this.selectedStage = stage;
    this.selectedRole = role;
    this.calculateStaffAvailability(stage, role);
    this.showAssignModal = true;
  }

  onEditCrew(stage: EventStage, role: RoleAssignment, member: CrewMember): void {
    this.memberToReassign = member;
    this.selectedStage = stage;
    this.selectedRole = role;
    this.calculateStaffAvailability(stage, role, member);
    this.showAssignModal = true;
  }

  normalizeRoleName(role: string | null | undefined): string {
    if (!role) return '';
    return role.toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  isRoleMatching(staffRole: string | null | undefined, targetRole: string | null | undefined): boolean {
    const sRole = this.normalizeRoleName(staffRole);
    const tRole = this.normalizeRoleName(targetRole);
    if (!sRole || !tRole) return false;
    return sRole === tRole || sRole.includes(tRole) || tRole.includes(sRole);
  }

  calculateStaffAvailability(stage: EventStage, role: RoleAssignment, currentMember?: CrewMember): void {
    const stageDateStr = this.normalizeDate(stage.rawDate);

    // Only include staff members whose role matches the target role
    const matchingStaff = this.allStaff.filter(staff => this.isRoleMatching(staff.role, role.role));

    const staffWithAvailability: StaffWithAvailability[] = matchingStaff.map(staff => {
      const staffAssignments = this.crewAssignments.filter(ca => 
        ca.staff_id === staff.id && 
        this.normalizeDate(ca.event_date) === stageDateStr
      );

      // If reassigning, the currently assigned member can remain selectable, or other staff with 0 assignments on that date
      const isCurrentEditingMember = currentMember && staff.id === currentMember.id;
      const isAvailable = staffAssignments.length === 0 || !!isCurrentEditingMember;

      return {
        ...staff,
        isAvailable,
        isRoleMatch: true,
        existingAssignments: staffAssignments.length,
        conflictingDates: staffAssignments.map(ca => ca.event_date)
      };
    });

    this.availableStaffForRole = staffWithAvailability.sort((a, b) => {
      if (a.isAvailable && !b.isAvailable) return -1;
      if (!a.isAvailable && b.isAvailable) return 1;
      return (a.staff_name || a.name || '').localeCompare(b.staff_name || b.name || '');
    });
  }

  closeAssignModal(): void {
    this.showAssignModal = false;
    this.selectedStage = null;
    this.selectedRole = null;
    this.memberToReassign = null;
    this.availableStaffForRole = [];
  }

  assignStaffToRole(staff: StaffWithAvailability): void {
    if (!this.selectedStage || !this.selectedRole) {
      console.error('Missing stage or role');
      this.error = 'Missing stage or role information';
      return;
    }

    const booking = this.bookingQueue.find(b => 
      b.stages.some(s => s.id === this.selectedStage?.id)
    );
    
    if (!booking) {
      console.error('Booking not found for stage');
      this.error = 'Booking not found for this stage';
      return;
    }

    const stage = booking.stages.find(s => s.id === this.selectedStage?.id);
    
    if (!stage) {
      console.error('Stage not found');
      this.error = 'Stage not found in booking';
      return;
    }

    this.bookingService.getBookingById(booking.id).subscribe({
      next: (bookingResponse) => {
        const fullBooking = bookingResponse.booking;
        
        const eventDay = fullBooking.event_days?.find(ed => 
          (stage.booking_event_id && ed.id === stage.booking_event_id) ||
          (ed.event_name?.toLowerCase() === stage.name.toLowerCase() && 
           this.normalizeDate(ed.event_date) === this.normalizeDate(stage.rawDate))
        );

        if (!eventDay) {
          console.error('Event day not found for stage:', stage);
          this.error = `Could not find event details for "${stage.name}" on ${stage.date}`;
          return;
        }

        const existingAssignment = this.memberToReassign
          ? this.crewAssignments.find(ca => {
              if (ca.staff_id !== this.memberToReassign!.id) return false;
              if (ca.assigned_role.toLowerCase() !== this.selectedRole!.role.toLowerCase()) return false;
              if (ca.booking_event_id && stage.booking_event_id) {
                return ca.booking_event_id === stage.booking_event_id;
              }
              const isDateMatch = this.normalizeDate(ca.event_date) === this.normalizeDate(stage.rawDate);
              const isNameMatch = ca.event_name?.toLowerCase() === stage.name.toLowerCase();
              return isDateMatch && isNameMatch;
            })
          : null;

        if (existingAssignment) {
          // If the user selected the same person, just close the modal
          if (existingAssignment.staff_id === staff.id) {
            this.closeAssignModal();
            return;
          }

          // Update assignment to new staff member
          this.crewAssignmentService.updateCrewAssignment(existingAssignment.id, {
            staff_id: staff.id,
            booking_event_id: eventDay.id,
            assigned_role: this.selectedRole!.role,
            assignment_date: eventDay.event_date || stage.rawDate,
            status: 'confirmed'
          }).subscribe({
            next: () => {
              this.closeAssignModal();
              this.loadCrewAssignments();
            },
            error: (err) => {
              console.error('Error updating crew assignment:', err);
              this.error = `Failed to update crew assignment: ${err.message || err.status || 'Unknown error'}`;
            }
          });
          return;
        }

        const assignment: CreateCrewAssignmentRequest = {
          booking_event_id: eventDay.id,
          staff_id: staff.id,
          assigned_role: this.selectedRole!.role,
          assignment_date: eventDay.event_date || stage.rawDate,
          status: 'confirmed'
        };

        this.crewAssignmentService.createCrewAssignment(assignment).subscribe({
          next: (response) => {
            this.closeAssignModal();
            this.loadCrewAssignments();
          },
          error: (err) => {
            console.error('Error assigning crew:', err);
            this.error = `Failed to assign crew member: ${err.message || err.status || 'Unknown error'}`;
          }
        });
      },
      error: (err) => {
        console.error('Error fetching booking details:', err);
        this.error = `Failed to get booking details: ${err.message || err.status || 'Unknown error'}`;
      }
    });
  }

  refreshData(): void {
    this.loadCrewAssignments();
  }

  testConnection(): void {
    this.isLoading = true;
    this.error = null;

    this.http.get('https://wedflow-codeflare.onrender.com/api/bookings').subscribe({
      next: (response) => {
        this.error = 'Bookings API working. Check console for details.';
        this.isLoading = false;
      },
      error: (err) => {
        console.error('Bookings API test failed:', err);
        this.error = `Bookings API failed: ${err.status} - ${err.statusText || err.message}`;
        this.isLoading = false;
      }
    });
  }
}