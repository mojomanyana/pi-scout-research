# Source provenance

Scout 0.2.0 was first distributed through npm. This repository's v0.2.0 source
anchor contains the exact 29 package payload files from that release, plus public
test and repository maintenance files. It does not reconstruct earlier Git
history or claim the npm upload was built from a Git commit.

Published archive: pi-scout-research-0.2.0.tgz

SHA-256: 62130766ebd6a7197cbffbd876568381de15bedcdbc016f450cbf502e61c5087

The [payload inventory](source-0.2.0.json) records exact source bytes and archive
modes. The npm archive remains immutable. npm may remove the single CR in the
declared scout-catalog executable's first shebang line on installation; that known
installation transform does not alter this source anchor.

The eight public offline suites were retained from the qualified source checks
and relocated to tests/. Their product imports were adjusted to the repository
root; assertions and synthetic fixtures were retained. They cover 41 controls when
the documented Pi/Daddy dependencies are selected. These software controls are
not live model-quality evidence.

No private trial vaults, research briefs, model transcripts, authentication,
evaluation results or local evidence directories are part of this repository.
