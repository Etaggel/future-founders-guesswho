export type Attendee = {
  id: number;
  tagline: string;
  category: string;
  likely_match?: {
    name: string | null;
    confidence: number;
    linkedin_url: string | null;
    company?: string;
    role?: string;
    notes?: string;
  };
  identified_person?: {
    name: string;
    confidence: number;
    linkedin_url?: string;
    role?: string;
    company?: string;
  };
  profile_summary?: {
    background?: string;
    interests?: string[];
  };
  extra_facts?: Array<{
    fact: string;
    type?: string;
    use_for_conversation?: string;
  }>;
  conversation_starters?: string[];
};

export type FactsChallenge = {
  options: string[];
  lieIndex: number;
};

export type Mastery = Record<number, number>;

export type MatchProfile = {
  id: number;
  orientation: string;
  segment: string;
  core_domains: string[];
  strengths: string[];
  needs: string[];
  high_potential_matches: number[];
};

export type RelationshipEdge = {
  source: number;
  target: number;
  score: number;
  relationship_type: string;
  reasons: string[];
};

export type InsightCluster = {
  cluster: string;
  members: number[];
  opportunities: string[];
};

export type MatchData = {
  schema_version: string;
  attendee_segments: Record<string, number[]>;
  attendees: MatchProfile[];
  relationship_edges: RelationshipEdge[];
  insight_dimensions: {
    highest_domain_density_clusters?: InsightCluster[];
    people_likely_looking_for_technical_cofounder?: number[];
    people_likely_looking_for_commercial_cofounder?: number[];
    strongest_potential_matches_for_founder_16?: Array<{
      id: number;
      fit: string;
      why: string;
    }>;
  };
};
