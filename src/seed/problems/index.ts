import { Problem } from '../../domain/problem/Problem.js';
import { asProblemId, asScenarioId } from '../../domain/ids.js';
import { CORE_RUBRIC_ID } from '../rubric.js';

/**
 * Seeded practice problems.
 *
 * Four problems is deliberate for the MVP. The learner loop is "attempt, read
 * feedback, attempt again better" — depth of iteration on a few problems is
 * worth more than breadth, and a shallow catalogue of thirty would have hidden
 * the fact that repeat attempts are the point.
 *
 * Each problem carries two `changeScenarios`. The learner answers one, chosen
 * when they start the attempt, so a second attempt at the same problem is not a
 * memory exercise.
 */
export const SEED_PROBLEMS: readonly Problem[] = [
  new Problem({
    id: asProblemId('parking-lot'),
    slug: 'parking-lot',
    title: 'Parking Lot',
    difficulty: 'starter',
    estimatedMinutes: 35,
    summary:
      'Model a multi-floor parking lot that admits vehicles, allocates spots, and charges on exit.',
    statement: [
      'A parking lot operator runs a single site with multiple floors. Vehicles arrive at an entry gate, are issued a ticket, park in a spot appropriate to their size, and pay at an exit gate before leaving.',
      '',
      'Design the domain model for this system: the types, what each one is responsible for, and how they relate. Focus on the rules of the business — how a spot is chosen, how a fee is arrived at, how the lot knows whether it is full — rather than on databases, HTTP endpoints, or UI.',
    ].join('\n'),
    functionalRequirements: [
      'The lot has multiple floors; each floor has spots of different sizes (motorcycle, compact, large).',
      'A vehicle of a given type may occupy some spot sizes but not others.',
      'On entry, a vehicle is issued a ticket recording the spot assigned and the entry time.',
      'On exit, a fee is computed from the elapsed time and the spot size occupied.',
      'The lot must be able to report whether it can currently admit a given vehicle type.',
      'A spot occupied by one vehicle cannot be assigned to another.',
    ],
    constraints: [
      'Single physical site — no multi-site or franchise modelling.',
      'Assume at most a few thousand spots; nothing needs to be distributed.',
      'Payment succeeds or fails as a single step; no partial payments or refunds.',
    ],
    outOfScope: [
      'Persistence, schema design, and transactions',
      'REST/gRPC API surface',
      'Authentication and operator accounts',
      'Hardware integration with real gates or sensors',
    ],
    expectedConcepts: [
      'spot allocation strategy',
      'vehicle type to spot size compatibility',
      'ticket lifecycle',
      'fee calculation',
      'floor or level grouping',
      'occupancy tracking',
    ],
    changeScenarios: [
      {
        id: asScenarioId('parking-lot-ev'),
        prompt:
          'The operator adds electric-vehicle spots with chargers. EV spots are charged at the normal hourly rate plus a per-kWh energy fee, and an EV may park in a normal spot if no EV spot is free. What in your design changes, and what does not?',
        hints: ['spot type', 'pricing strategy', 'allocation strategy', 'open for extension'],
      },
      {
        id: asScenarioId('parking-lot-pricing'),
        prompt:
          'Marketing wants weekend rates, a flat-rate evening special, and a "first 30 minutes free" rule — all live at once, chosen per-ticket. What in your design changes, and what does not?',
        hints: ['pricing strategy', 'rule composition', 'polymorphism', 'configuration over code'],
      },
    ],
    rubricId: CORE_RUBRIC_ID,
  }),

  new Problem({
    id: asProblemId('elevator-system'),
    slug: 'elevator-system',
    title: 'Elevator System',
    difficulty: 'core',
    estimatedMinutes: 40,
    summary:
      'Model a bank of elevators serving a building, including request dispatch and car movement.',
    statement: [
      'A building has several elevator cars serving a fixed set of floors. People press call buttons on floors (with a direction) and destination buttons inside cars. A controller decides which car serves which request, and each car moves, stops, and opens its doors accordingly.',
      '',
      "Design the domain model. The interesting decisions are where the dispatch policy lives, how a car's state is represented, and how a request travels from a button press to a stop.",
    ].join('\n'),
    functionalRequirements: [
      'Multiple cars serve a shared set of floors.',
      'A floor call specifies a direction (up/down); an in-car request specifies a destination floor.',
      'A car has a current floor, a direction of travel, and a door state.',
      'Some policy selects which car serves a given floor call.',
      'A car serves its pending stops in an order that makes physical sense for its direction of travel.',
      'A car can be taken out of service for maintenance and must not receive new assignments.',
    ],
    constraints: [
      'Single building, fixed floor range.',
      'Model the logic, not real-time control or motor hardware.',
      'Assume requests arrive one at a time and are handled in-process.',
    ],
    outOfScope: [
      'Threading, locking, and real-time scheduling guarantees',
      'Persistence and telemetry',
      'Emergency/fire-service regulatory modes',
    ],
    expectedConcepts: [
      'dispatch strategy',
      'car state machine',
      'direction of travel',
      'request queue per car',
      'door state',
      'out-of-service handling',
    ],
    changeScenarios: [
      {
        id: asScenarioId('elevator-express'),
        prompt:
          'The building adds an express car that only serves floors 1, 20 and above, and a rule that during morning rush idle cars return to the lobby. What in your design changes, and what does not?',
        hints: ['dispatch strategy', 'car capability', 'idle policy', 'strategy pattern'],
      },
      {
        id: asScenarioId('elevator-destination'),
        prompt:
          'The operator switches to destination-dispatch: passengers enter their destination at a lobby kiosk before boarding and are told which car to take. What in your design changes, and what does not?',
        hints: ['request model', 'dispatch strategy', 'grouping requests', 'interface stability'],
      },
    ],
    rubricId: CORE_RUBRIC_ID,
  }),

  new Problem({
    id: asProblemId('vending-machine'),
    slug: 'vending-machine',
    title: 'Vending Machine',
    difficulty: 'starter',
    estimatedMinutes: 30,
    summary:
      'Model a vending machine that takes payment, dispenses a product, and returns change.',
    statement: [
      'A vending machine holds products in slots. A customer selects a slot, inserts coins or pays by card, and receives the product plus any change. The machine refuses selections it cannot satisfy — sold out, insufficient payment, or unable to make change.',
      '',
      "Design the domain model, paying particular attention to how the machine's behaviour changes with its state, and where the rules about money live.",
    ].join('\n'),
    functionalRequirements: [
      'Products live in slots, each with a price and a quantity.',
      'A customer inserts money incrementally before selecting, or pays by card at selection.',
      'The machine dispenses only when payment covers the price and stock exists.',
      'Change is returned from the coins the machine actually holds.',
      'A selection that cannot be satisfied is refused with a reason, and inserted money is returned.',
      'An operator can restock products and coins.',
    ],
    constraints: [
      'Single machine, single currency.',
      'Card payment either authorises or declines; no chargebacks.',
      'No network calls need to be modelled beyond a payment authorisation boundary.',
    ],
    outOfScope: [
      'Persistence',
      'Remote telemetry / fleet management',
      'Physical hardware drivers',
    ],
    expectedConcepts: [
      'machine state machine',
      'payment method abstraction',
      'inventory / slot management',
      'change-making',
      'refusal reasons',
      'operator restock',
    ],
    changeScenarios: [
      {
        id: asScenarioId('vending-payments'),
        prompt:
          'The operator adds mobile-wallet QR payment and staff badge payment (deducted from a monthly allowance, never needing change). What in your design changes, and what does not?',
        hints: ['payment abstraction', 'polymorphism', 'change handling', 'open/closed'],
      },
      {
        id: asScenarioId('vending-promos'),
        prompt:
          'The machine must support "buy 2 get 1 free" on selected slots and a happy-hour discount between 3pm and 5pm. What in your design changes, and what does not?',
        hints: ['pricing rule', 'rule composition', 'where price is computed', 'strategy'],
      },
    ],
    rubricId: CORE_RUBRIC_ID,
  }),

  new Problem({
    id: asProblemId('splitwise'),
    slug: 'splitwise',
    title: 'Expense Splitting (Splitwise)',
    difficulty: 'advanced',
    estimatedMinutes: 45,
    summary:
      'Model shared expenses across groups, with several split methods and a running balance per person.',
    statement: [
      'A group of people share expenses. Someone pays for something, and the cost is split among participants — equally, by exact amounts, by percentage, or by shares. The system tracks who owes whom, and can simplify a tangle of debts into the fewest transfers.',
      '',
      'Design the domain model. The interesting decisions are how a split method is represented, how balances are derived, and what invariants must always hold about money.',
    ].join('\n'),
    functionalRequirements: [
      'People belong to zero or more groups; an expense may be in a group or between individuals.',
      'An expense records who paid, how much, and how it is split among participants.',
      'Splits may be equal, exact amounts, percentages, or shares.',
      'The sum of a split must always equal the expense total.',
      'The system reports a net balance per person and who owes whom.',
      'A settlement (one person paying another) adjusts balances.',
    ],
    constraints: [
      'Single currency; ignore FX.',
      'Amounts are exact to the smallest currency unit — rounding must not create or destroy money.',
      'In-memory modelling is fine; no storage design needed.',
    ],
    outOfScope: [
      'Auth and invitations',
      'Notifications',
      'Payment rails / actual money movement',
    ],
    expectedConcepts: [
      'split strategy',
      'balance derivation',
      'settlement',
      'group membership',
      'rounding / money invariant',
      'debt simplification',
    ],
    changeScenarios: [
      {
        id: asScenarioId('splitwise-recurring'),
        prompt:
          'Users want recurring expenses (rent on the 1st of each month) and the ability to edit an expense after the fact, with balances staying correct. What in your design changes, and what does not?',
        hints: [
          'derived vs stored balance',
          'expense immutability',
          'event sourcing',
          'recurrence',
        ],
      },
      {
        id: asScenarioId('splitwise-currency'),
        prompt:
          'The group travels and starts logging expenses in several currencies, settling in one chosen home currency at the rate on the expense date. What in your design changes, and what does not?',
        hints: [
          'money value object',
          'exchange rate provider',
          'balance aggregation',
          'value objects',
        ],
      },
    ],
    rubricId: CORE_RUBRIC_ID,
  }),
];
