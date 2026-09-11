import type {
  ChangeScenarioAnswer,
  DeclaredType,
  Relationship,
  SubmissionContent,
  SubmissionFormat,
} from './SubmissionContent.js';
import { ValidationError } from '../errors.js';

/**
 * A format-neutral view of "the design the learner is proposing".
 *
 * This is the seam that makes change test A cheap. Deterministic rules do not
 * read `DesignSpecContent`; they read a `DesignGraph`. A class diagram and a
 * structured form describe the same underlying thing — named types with
 * responsibilities, and edges between them — so a future `ClassDiagramAdapter`
 * that parses mermaid into this shape makes every existing rule work on
 * diagrams without a single rule being edited.
 *
 * The graph is a projection, not a store. The original submission content is
 * always kept verbatim, because feedback must quote the learner's own words.
 */
export class DesignGraph {
  readonly sourceFormat: SubmissionFormat;
  readonly types: readonly DeclaredType[];
  readonly relationships: readonly Relationship[];
  readonly assumptions: readonly string[];
  readonly tradeoffs: string;
  readonly changeScenarioAnswers: readonly ChangeScenarioAnswer[];

  private readonly typesByLowerName: ReadonlyMap<string, DeclaredType>;

  constructor(params: {
    sourceFormat: SubmissionFormat;
    types: readonly DeclaredType[];
    relationships: readonly Relationship[];
    assumptions: readonly string[];
    tradeoffs: string;
    changeScenarioAnswers: readonly ChangeScenarioAnswer[];
  }) {
    this.sourceFormat = params.sourceFormat;
    this.types = params.types;
    this.relationships = params.relationships;
    this.assumptions = params.assumptions;
    this.tradeoffs = params.tradeoffs;
    this.changeScenarioAnswers = params.changeScenarioAnswers;
    this.typesByLowerName = new Map(params.types.map((t) => [t.name.trim().toLowerCase(), t]));
  }

  get typeNames(): readonly string[] {
    return this.types.map((t) => t.name);
  }

  findType(name: string): DeclaredType | undefined {
    return this.typesByLowerName.get(name.trim().toLowerCase());
  }

  hasType(name: string): boolean {
    return this.typesByLowerName.has(name.trim().toLowerCase());
  }

  get abstractions(): readonly DeclaredType[] {
    return this.types.filter((t) => t.kind === 'interface' || t.kind === 'abstract-class');
  }

  get concreteClasses(): readonly DeclaredType[] {
    return this.types.filter((t) => t.kind === 'class');
  }

  /** Edges whose endpoints do not name a declared type — a dangling design. */
  get danglingRelationships(): readonly Relationship[] {
    return this.relationships.filter((r) => !this.hasType(r.from) || !this.hasType(r.to));
  }

  /** Declared types that no relationship touches in either direction. */
  get orphanTypes(): readonly DeclaredType[] {
    const touched = new Set<string>();
    for (const r of this.relationships) {
      touched.add(r.from.trim().toLowerCase());
      touched.add(r.to.trim().toLowerCase());
    }
    return this.types.filter((t) => !touched.has(t.name.trim().toLowerCase()));
  }

  /**
   * Cycles in the inheritance edges only. Cycles among `uses` edges are a smell
   * worth mentioning but are legal and common; a cycle in `extends`/`implements`
   * is simply not a design that can exist.
   */
  findInheritanceCycles(): readonly string[][] {
    const edges = this.relationships.filter(
      (r) => r.type === 'extends' || r.type === 'implements',
    );
    const adjacency = new Map<string, string[]>();
    for (const e of edges) {
      const from = e.from.trim().toLowerCase();
      const to = e.to.trim().toLowerCase();
      adjacency.set(from, [...(adjacency.get(from) ?? []), to]);
    }

    const cycles: string[][] = [];
    const state = new Map<string, 'visiting' | 'done'>();
    const stack: string[] = [];

    const visit = (node: string): void => {
      const current = state.get(node);
      if (current === 'done') return;
      if (current === 'visiting') {
        const start = stack.indexOf(node);
        if (start >= 0) cycles.push([...stack.slice(start), node]);
        return;
      }
      state.set(node, 'visiting');
      stack.push(node);
      for (const next of adjacency.get(node) ?? []) visit(next);
      stack.pop();
      state.set(node, 'done');
    };

    for (const node of adjacency.keys()) visit(node);
    return cycles;
  }

  /** Interfaces/abstract classes that nothing declares itself as implementing. */
  get unimplementedAbstractions(): readonly DeclaredType[] {
    const implemented = new Set(
      this.relationships
        .filter((r) => r.type === 'implements' || r.type === 'extends')
        .map((r) => r.to.trim().toLowerCase()),
    );
    return this.abstractions.filter((a) => !implemented.has(a.name.trim().toLowerCase()));
  }

  /** All learner-written prose, used for concept coverage and quoting evidence. */
  get narrativeText(): string {
    return [
      ...this.assumptions,
      this.tradeoffs,
      ...this.changeScenarioAnswers.map((a) => a.text),
      ...this.types.map((t) => `${t.name}: ${t.responsibility}`),
    ].join('\n');
  }

  /** Everything the learner wrote, including member names. */
  get fullText(): string {
    const members = this.types.flatMap((t) => [
      ...t.attributes.map((a) => a.name),
      ...t.methods.map((m) => m.name),
    ]);
    return [this.narrativeText, ...members, ...this.relationships.map((r) => `${r.from} ${r.type} ${r.to}`)].join('\n');
  }
}

/**
 * Projects one submission format into the shared graph.
 *
 * Registering a new adapter is the entire cost of supporting a new submission
 * format for every deterministic rule that already exists.
 */
export interface SubmissionContentAdapter {
  readonly format: SubmissionFormat;
  toGraph(content: SubmissionContent): DesignGraph;
}

export class DesignSpecAdapter implements SubmissionContentAdapter {
  readonly format = 'design-spec' as const;

  toGraph(content: SubmissionContent): DesignGraph {
    if (content.format !== 'design-spec') {
      throw new ValidationError(`DesignSpecAdapter cannot handle format "${content.format}".`);
    }
    return new DesignGraph({
      sourceFormat: content.format,
      types: content.types,
      relationships: content.relationships,
      assumptions: content.assumptions,
      tradeoffs: content.tradeoffs,
      changeScenarioAnswers: content.changeScenarioAnswers,
    });
  }
}

export class AdapterRegistry {
  private readonly adapters = new Map<SubmissionFormat, SubmissionContentAdapter>();

  register(adapter: SubmissionContentAdapter): this {
    this.adapters.set(adapter.format, adapter);
    return this;
  }

  toGraph(content: SubmissionContent): DesignGraph {
    const adapter = this.adapters.get(content.format);
    if (!adapter) {
      throw new ValidationError(
        `No adapter registered for submission format "${content.format}".`,
      );
    }
    return adapter.toGraph(content);
  }

  supports(format: SubmissionFormat): boolean {
    return this.adapters.has(format);
  }
}

export function defaultAdapterRegistry(): AdapterRegistry {
  return new AdapterRegistry().register(new DesignSpecAdapter());
}
