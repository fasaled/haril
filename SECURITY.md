# Security policy

## Supported versions

Haril is pre-1.0. Security fixes are applied to the latest version on the
default branch; older snapshots are not supported.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private
vulnerability reporting feature for this repository. If that feature is not
available, contact the repository owner privately through the contact method
listed on the GitHub profile.

Include the affected version or commit, platform and architecture, impact,
reproduction steps, and any suggested mitigation. Do not attach real capture
packages or data from systems you do not own.

Please allow reasonable time for investigation and remediation before public
disclosure.

## Sensitive data

`.haril` packages can expose filesystem paths, process names, timestamps, file
identifiers, and activity patterns. Treat captures as sensitive forensic data
even though Haril does not intentionally package file contents.
