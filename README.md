# H5P.ScaleQuestion

H5P.ScaleQuestion is an interactive, gradable H5P question type in which learners select a position on a scale. This repository contains the initial 0.1.0 version.

## Question modes

ScaleQuestion supports two modes:

- **Numerical scale:** configure a minimum, maximum, selectable step, reference answer, and optional accepted tolerance.
- **Custom points:** configure an ordered list of reference points. The authored list is not sorted. Vertical questions display the first authored point at the top; horizontal questions reverse the visual left-to-right order so lower or earlier points can appear on the left.

Both modes support horizontal and vertical orientations. Custom-point mode requires between 2 and 12 valid reference points, with exactly one point marked as correct.

## Authoring options

Authors can configure:

- Question text and optional image, video, or audio media. Image zooming can be disabled.
- Numerical or custom-point scale mode and horizontal or vertical orientation.
- Numerical minimum, maximum, selectable step, reference answer, and accepted tolerance.
- Custom-point values, optional labels, ordering, and the correct point.
- Maximum number of attempts.
- Manual checking or automatic checking after selection.
- Retry and Show Solution availability.
- Directional, correct, incorrect, terminal, tolerance, and solution feedback text.
- Accessible scale labels, announcements, button labels, score text, and configuration-error messages.

## Answer checking and scoring

With manual checking, the learner selects a position and presses **Check**. With automatic checking enabled, selecting a position submits it immediately and the Check button is not displayed.

The maximum score is 1. A correct answer is terminal. An incorrect answer is terminal when the configured attempt limit is reached or Retry is disabled. When Retry is enabled and attempts remain, an incorrect answer enters an intermediate retry state. Retry clears the selection and unlocks the scale without resetting the number of attempts already used.

Reset restores the initial unanswered state. When enabled, Show Solution is made available according to the terminal-incorrect result rules; revealing the solution does not alter the submitted answer, attempt count, or score.

The library saves the selected position, attempt and completion state, correctness, and solution visibility. Compatible saved state is restored without replaying completion events. A terminal result emits one xAPI `answered` event, including completion, success, response, and score data.

## Configuration requirements

Numerical configurations require:

- Finite numerical values.
- A minimum below the maximum.
- A positive selectable step.
- A non-negative accepted tolerance.
- A reference answer inside the configured domain.
- With zero tolerance, a reference answer reachable from the minimum using the selectable step.
- With positive tolerance, at least one selectable position inside the inclusive accepted interval.

Custom-point configurations require 2–12 valid reference points and exactly one point marked correct. Point values are required and are treated as text; labels are optional.

Invalid configurations display localized runtime configuration-error messages. Version 0.1.0 does not provide a custom editor validator.

## Accessibility and localization

The scale uses native range-input behavior and supports arrow keys, Home, End, Enter, and Space as appropriate for navigation and selection. It provides accessible scale labels, orientation and value information, live feedback announcements, custom-point descriptions, score text, and managed focus. This describes implemented support and is not a formal accessibility certification.

English is the source language. A French translation is included in `language/fr.json`. The H5P host/editor language determines the authoring interface, while saved interface-text defaults in authored content can also affect the language shown to learners.

## Dependencies and installation

Library metadata:

- Machine name: `H5P.ScaleQuestion`
- Version: `0.1.0`
- H5P core API: `1.28`
- Runnable: yes
- Embedding mode: `iframe`
- Preloaded dependency: `H5P.Question 1.5`
- Editor dependency: `H5PEditor.ShowWhen 1.0`

Install a finished `.h5p` package using the library or content-type administration facility of a compatible H5P host. A library-only package contains ScaleQuestion but not its dependencies, so those dependencies must already be available on the host. A recursively created package may include dependencies as well.

No compatibility with a particular host product or host version is implied beyond the declared H5P metadata.

## Development and testing

The repository contains directly usable JavaScript, CSS, JSON, and translation files. No compilation or build step is required.

Run the complete automated test suite from the repository root:

```console
npm test
```

The suite uses Node.js's built-in test runner. The current project has no npm dependencies, so dependency installation is not required before running it.

For local H5P CLI development, place or link the repository at `libraries/H5P.ScaleQuestion-0.1` inside the development environment and ensure the declared runtime and editor dependencies are installed.

## Packaging

From the local H5P development environment, create a validated library-only package with:

```powershell
cd C:\my_first_h5p_environment\libraries
h5p utils pack H5P.ScaleQuestion-0.1 H5P.ScaleQuestion-0.1.0.h5p
```

This non-recursive command does not bundle dependencies. The `.h5pignore` file excludes tests and other development-only files from the package.

## License

H5P.ScaleQuestion is released under the [MIT License](LICENSE.txt).

Copyright (c) 2026 Joseph Rézeau.
