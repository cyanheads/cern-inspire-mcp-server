---
name: cern-inspire-guide
description: Use cern_inspire_* tools for HEP literature research, author or institution citation analysis, citation-network exploration, bibliography assembly, and finding numerical-data publications. Resolve identities, verify query scope, and distinguish publication-year filters from citation-year series before drawing conclusions.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.0"
---

## Scope

INSPIRE-HEP covers high-energy-physics literature, author profiles, experiments, and publication-level HEPData records through a keyless API. Numerical table values require the returned HEPData record page; this server cannot read them.

## Identifiers

Recids belong to separate collections. Keep each ID attached to its source: literature recids from `cern_inspire_search_literature` or `cern_inspire_get_paper`; author recids and BAIs from `cern_inspire_search_authors`; experiment queries from `cern_inspire_search_experiments`; institution recids from author positions or experiment institutions. A numeric paper ID is not an author or institution ID.

Reuse returned `literatureQuery` values for author and experiment cohorts. For institutions, build `affid:N` only from a returned institution recid. A HEPData record DOI identifies data, not the associated literature record; follow returned paper recids for the publication.

## Gates

1. Resolve a person's name before attributing papers or metrics. Compare candidate profiles' affiliations, categories, and identifiers; do not select the first namesake by rank. A missing ORCID match can mean the profile has no linked ORCID: search by name before concluding the person is absent.
2. Inspect representative literature matches before summarizing or exporting a cohort. Check the effective query and applied filters. An unexpectedly broad or empty result can be malformed syntax despite a successful response; consult `cern_inspire_list_reference` before treating it as evidence. Multiple document types or subjects intersect; they do not form a union.
3. Resolve an old paper ID with `cern_inspire_get_paper` before concluding a query has no matching paper, citations, or references. Merged IDs can match nothing in queries; use the surviving recid returned by the dossier.
4. Distinguish papers published in a year range from citations received in that range. Summary year filters select the papers and leave out the yearly citation series. For citation-year questions, obtain the full series and select its returned year rows. An omitted series is unavailable, not zero; it counts citations over all matched records and need not sum to the citeable-paper total.
5. Establish coverage before claiming a complete bibliography or literature set. Follow returned continuation signals and notices; do not keep probing until a page is empty. Literature search reports `totalCount` and `hasMore`; export uses `nextPage`, `truncated`, and notices, with no total count. Beyond the 10,000-result window, narrow the query and report the remaining coverage limit. Pages reflect a changing index: deduplication removes repeats but cannot prove that no papers were skipped.
6. Distinguish an unsuccessful HEPData availability lookup from a negative result. Publication-level data metadata does not establish any particular table's contents or values.

## Core chain

Resolve the paper, person, or experiment → inspect the selected literature cohort → retrieve dossiers, summarize citations, or export the verified set. Keep the same query and filters when carrying a cohort between tools.

## Workflows

**Author or institution analysis.** Resolve a person with `cern_inspire_search_authors`, inspect their returned literature query, then use `cern_inspire_get_citation_summary` for the selected profile. For an institution, use a linked institution recid with `affid:N`; this includes linked author/supervisor affiliations, thesis institutions, and record-level affiliations, so describe that scope rather than calling it an employee-only publication count. Compare like scopes: all citeable versus published, the same publication years, and the same self-citation treatment.

**Citation networks and bibliographies.** Start with `cern_inspire_get_paper` and reuse its ready-made queries for citing papers or references; the INSPIRE operators are easy to reverse (`refersto` finds citing papers, `citedby` finds references). Inspect the set with `cern_inspire_search_literature`, then call `cern_inspire_export_citations`. For a curated shortlist, export the selected literature recids joined with `or` instead of rerunning the broad discovery query. Keep query, filters, sort, and page size fixed during pagination, and preserve any coverage notices with the bibliography.

**Measurements and numerical data.** When the paper is unknown, use `cern_inspire_search_hepdata` with the process, observable, energy, or collaboration. Follow its paper recids to `cern_inspire_get_paper` for publication context. When starting from an experiment, resolve it with `cern_inspire_search_experiments` and reuse its literature query to find the relevant paper. Return the HEPData record page for reading or downloading tables and its record DOI for citing the data; do not infer numerical results from keywords or table counts.

## References

Call `cern_inspire_list_reference` for INSPIRE query syntax, identifier forms, document types, subjects, citation buckets, and HEPData version/DOI conventions. In particular, literature queries require unversioned arXiv IDs, and ORCIDs resolve through author tools rather than literature queries.
