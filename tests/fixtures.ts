import { asScenarioId } from '../src/domain/ids.js';
import type {
  DeclaredType,
  DesignSpecContent,
  Relationship,
} from '../src/domain/submission/SubmissionContent.js';

/**
 * Test fixtures.
 *
 * The two named designs below are the backbone of several tests: `strongDesign`
 * and `alternativeStrongDesign` solve the same parking-lot problem in visibly
 * different ways (strategy-per-concern versus a policy object with a registry).
 * Asserting that both score respectably is how the suite defends the product's
 * central claim — that evaluation rewards design quality rather than
 * resemblance to one blessed answer.
 */

function type(
  name: string,
  responsibility: string,
  kind: DeclaredType['kind'] = 'class',
  methods: string[] = [],
): DeclaredType {
  return {
    name,
    responsibility,
    kind,
    attributes: [],
    methods: methods.map((m) => ({ name: m })),
  };
}

function rel(from: string, type: Relationship['type'], to: string): Relationship {
  return { from, to, type };
}

export const strongDesign: DesignSpecContent = {
  format: 'design-spec',
  assumptions: [
    'A vehicle occupies exactly one spot; oversized vehicles are refused rather than spanning spots.',
    'Fees are computed on exit from the spot size and elapsed time, rounded up to the hour.',
    'The lot runs in a single process, so occupancy is tracked in memory.',
  ],
  types: [
    type('ParkingLot', 'Admits and releases vehicles by coordinating floors and tickets.', 'class', [
      'admit',
      'release',
      'canAdmit',
    ]),
    type('Floor', 'Holds the spots on one level and reports its own availability.', 'class', [
      'findFreeSpot',
      'availability',
    ]),
    type('ParkingSpot', 'Tracks whether it is occupied and which vehicle sizes it accepts.', 'class', [
      'occupy',
      'release',
      'accepts',
    ]),
    type('Vehicle', 'Represents an arriving vehicle and its size class.', 'class'),
    type('Ticket', 'Records the spot, entry time and issuing gate for one parking session.', 'class'),
    type(
      'AllocationStrategy',
      'Chooses which free spot a given vehicle should be given.',
      'interface',
      ['allocate'],
    ),
    type(
      'NearestFirstAllocation',
      'Allocates the free spot closest to the entry gate.',
      'class',
      ['allocate'],
    ),
    type('PricingStrategy', 'Computes the fee owed for a completed parking session.', 'interface', [
      'priceFor',
    ]),
    type('HourlyPricing', 'Prices a session at a flat rate per started hour.', 'class', ['priceFor']),
  ],
  relationships: [
    rel('ParkingLot', 'owns', 'Floor'),
    rel('Floor', 'owns', 'ParkingSpot'),
    rel('ParkingSpot', 'uses', 'Vehicle'),
    rel('ParkingLot', 'creates', 'Ticket'),
    rel('ParkingLot', 'uses', 'AllocationStrategy'),
    rel('NearestFirstAllocation', 'implements', 'AllocationStrategy'),
    rel('ParkingLot', 'uses', 'PricingStrategy'),
    rel('HourlyPricing', 'implements', 'PricingStrategy'),
    rel('PricingStrategy', 'uses', 'Ticket'),
  ],
  tradeoffs: [
    'Allocation and pricing are separate interfaces rather than methods on ParkingLot, because both vary independently and for different business reasons.',
    'Occupancy is held on ParkingSpot rather than in a central index: it keeps the invariant next to the data it constrains, at the cost of a scan to find a free spot, which is acceptable at a few thousand spots.',
    'Ticket is immutable once issued so a fee can always be recomputed from it.',
  ].join(' '),
  changeScenarioAnswers: [
    {
      scenarioId: asScenarioId('parking-lot-ev'),
      text: 'I would add an EvSpot subtype of ParkingSpot carrying a charger reference, and an EvPricing implementation of PricingStrategy that wraps HourlyPricing and adds the per-kWh component. NearestFirstAllocation needs a variant that prefers EvSpot for electric vehicles and falls back to a normal spot, which is a new AllocationStrategy implementation rather than a change to the existing one. ParkingLot, Floor, Ticket and the two strategy interfaces are untouched, because the lot only ever talks to the interfaces.',
    },
  ],
};

/**
 * A genuinely different but comparably good design: one composable policy
 * object instead of two strategy interfaces, and a registry keyed by spot type.
 */
export const alternativeStrongDesign: DesignSpecContent = {
  format: 'design-spec',
  assumptions: [
    'Spot capability is data, not a subclass hierarchy, so new spot kinds are configuration rather than code.',
    'Fees and allocation are both expressions of one policy object owned by the lot operator.',
    'Tickets are events appended to a session log rather than mutable records.',
  ],
  types: [
    type('Lot', 'Serves entry and exit requests against the current occupancy view.', 'class', [
      'handleEntry',
      'handleExit',
    ]),
    type('SpotRegistry', 'Indexes spots by capability and hands out free ones.', 'class', [
      'reserve',
      'release',
      'freeMatching',
    ]),
    type('Spot', 'A physical space described by the capabilities it offers.', 'class'),
    type('Capability', 'A named property a spot offers, such as size or charging.', 'enum'),
    type('SessionLog', 'Append-only record of entry and exit events for auditing.', 'class', [
      'append',
      'sessionFor',
    ]),
    type(
      'LotPolicy',
      'Encapsulates the operator rules for matching and charging a session.',
      'interface',
      ['match', 'charge'],
    ),
    type(
      'StandardLotPolicy',
      'Applies the default matching and per-hour charging rules.',
      'class',
      ['match', 'charge'],
    ),
  ],
  relationships: [
    rel('Lot', 'owns', 'SpotRegistry'),
    rel('SpotRegistry', 'owns', 'Spot'),
    rel('Spot', 'uses', 'Capability'),
    rel('Lot', 'owns', 'SessionLog'),
    rel('Lot', 'uses', 'LotPolicy'),
    rel('StandardLotPolicy', 'implements', 'LotPolicy'),
    rel('LotPolicy', 'uses', 'SessionLog'),
  ],
  tradeoffs: [
    'Capabilities as data rather than spot subclasses means a new spot kind is a configuration change, at the cost of losing compile-time guarantees about which spots exist.',
    'Matching and charging live on one LotPolicy because in this business they change together whenever the operator changes commercial terms; splitting them would create two things to keep consistent.',
    'An append-only SessionLog makes fees recomputable and disputes auditable, at the cost of deriving current occupancy rather than reading it.',
  ].join(' '),
  changeScenarioAnswers: [
    {
      scenarioId: asScenarioId('parking-lot-ev'),
      text: 'Adding EV support is mostly data: a Charging entry in Capability and spots configured with it, so SpotRegistry already matches EVs to EV spots and falls back to plain spots through the same capability query. The commercial change is a new LotPolicy implementation adding the per-kWh component to charge. Lot, Spot, SpotRegistry and SessionLog need no modification at all, which was the reason for pushing spot kinds into Capability in the first place.',
    },
  ],
};

/** A thin submission: the shape a first attempt often really takes. */
export const weakDesign: DesignSpecContent = {
  format: 'design-spec',
  assumptions: [],
  types: [
    type('ParkingLot', 'Handles everything about parking and manages the cars and payments.', 'class', [
      'park',
      'unpark',
      'calculatePrice',
      'addFloor',
      'removeFloor',
      'checkAvailability',
      'processPayment',
    ]),
    type('Car', 'A car.', 'class'),
  ],
  relationships: [rel('ParkingLot', 'uses', 'Car')],
  tradeoffs: 'Simple.',
  changeScenarioAnswers: [
    {
      scenarioId: asScenarioId('parking-lot-ev'),
      text: 'I would add a new class for EV and handle it.',
    },
  ],
};

/** Structurally broken: a dangling edge, an orphan, and an inheritance cycle. */
export const brokenDesign: DesignSpecContent = {
  format: 'design-spec',
  assumptions: ['Assumes a single floor for simplicity.'],
  types: [
    type('ParkingLot', 'Coordinates entry and exit for the site.', 'class', ['admit']),
    type('Spot', 'Represents a single parking space that can be occupied.', 'class'),
    type('Ticket', 'Records an active parking session with its entry time.', 'class'),
    type('Auditor', 'Produces occupancy reports for the operator each night.', 'class'),
    type('Payment', 'Represents a payment taken at the exit gate.', 'class'),
  ],
  relationships: [
    rel('ParkingLot', 'owns', 'Spot'),
    // Endpoint that was never declared.
    rel('ParkingLot', 'uses', 'FeeCalculator'),
    // Impossible inheritance loop.
    rel('Ticket', 'extends', 'Payment'),
    rel('Payment', 'extends', 'Ticket'),
    // Auditor is declared but connected to nothing.
  ],
  tradeoffs:
    'Kept the model small so it is easy to follow, accepting that some responsibilities are implied rather than stated.',
  changeScenarioAnswers: [
    {
      scenarioId: asScenarioId('parking-lot-ev'),
      text: 'The Spot class would gain a flag for charging, and ParkingLot would check that flag when admitting an electric vehicle. Ticket would record the energy used so the fee can include it.',
    },
  ],
};
