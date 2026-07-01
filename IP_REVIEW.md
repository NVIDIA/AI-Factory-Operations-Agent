# IP Review

NVIDIA maintainers must complete the [NVIDIA IP review process](https://nv/ip_review_process) before distributing project modifications or accepting third-party contributions. The linked process requires NVIDIA-internal access.

For every contribution, maintainers must:

1. Identify whether each changed file is NVIDIA-authored, derived from third-party source, or generated from third-party source.
2. Verify that the contribution is covered by Apache-2.0 or another compatible license approved through the NVIDIA IP review process.
3. Preserve third-party copyright, license, source, and modification notices.
4. Add or update [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and the corresponding files under [third_party_licenses](third_party_licenses/) when dependencies change.
5. Verify NVIDIA-authored source carries the approved NVIDIA copyright and `SPDX-License-Identifier: Apache-2.0` header.
6. Verify external commits are signed off under the [Developer Certificate of Origin](DCO.md).
7. Complete the NVIDIA IP review before merge or distribution.

This checklist supplements rather than replaces the NVIDIA IP review process.
