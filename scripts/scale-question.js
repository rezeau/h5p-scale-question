H5P.ScaleQuestion = (function ($, Question) {
  'use strict';

  var MAX_SCORE = 1;
  var STATE_VERSION = 1;
  var MAX_SAFE_INTEGER = 9007199254740991;

  var DEFAULTS = {
    media: null,
    question: '',
    minimum: 0,
    maximum: 10,
    step: 1,
    correctValue: 5,
    acceptedTolerance: 0,
    scaleMode: 'numerical',
    customPoints: [],
    feedbackBelowCorrect: '',
    feedbackAboveCorrect: '',
    maxAttempts: 2,
    orientation: 'horizontal',
    behaviour: {
      autoCheck: false,
      enableRetry: true,
      enableSolutionsButton: true
    },
    l10n: {
      scaleLabel: 'Numerical scale',
      customScaleLabel: 'Custom-point scale',
      cursorValue: 'Cursor at @value. Select this value to answer.',
      selectedValue: 'Selected value: @value',
      checkAnswer: 'Check',
      tryAgain: 'Retry',
      showSolution: 'Show solution',
      correctAnswer: 'Correct answer: @value',
      correctFeedback: 'Correct.',
      incorrectFeedbackSingular: 'Incorrect. @remaining attempt remaining.',
      incorrectFeedbackPlural: 'Incorrect. @remaining attempts remaining.',
      terminalIncorrectFeedback: 'Incorrect. 0 attempts remaining.',
      acceptedRange: 'Accepted interval: @lower to @upper. Slider shows accepted position @value.',
      acceptedToleranceFeedback: 'Your answer is within the accepted tolerance of ±@tolerance.',
      scoreBarLabel: 'You got :num out of :total points',
      defaultTitle: 'Scale Question',
      configurationErrorPrefix: 'Scale Question configuration error:',
      maxAttemptsError: 'Maximum attempts must be a positive integer.',
      customPointsCountError: 'Custom points must contain between 2 and 12 points.',
      customPointValueRequiredError: 'Custom point @index requires a value.',
      customPointValueLengthError: 'Custom point @index value must not exceed 40 characters.',
      customPointLabelTypeError: 'Custom point @index label must be text.',
      customPointLabelLengthError: 'Custom point @index label must not exceed 80 characters.',
      customPointCorrectCountError: 'Exactly one custom point must be marked correct.',
      minimumFiniteError: 'Minimum value must be a finite number.',
      maximumFiniteError: 'Maximum value must be a finite number.',
      stepFiniteError: 'Selectable step must be a finite number.',
      correctValueFiniteError: 'Reference answer must be a finite number.',
      acceptedToleranceFiniteError: 'Accepted tolerance must be a finite number.',
      minimumMaximumError: 'Minimum must be less than maximum.',
      stepPositiveError: 'Selectable step must be positive.',
      toleranceNonNegativeError: 'Accepted tolerance must be non-negative.',
      correctValueRangeError: 'Correct value must be within the selectable domain.',
      safeIntegerError: 'Numerical scale values exceed the safe integer domain.',
      correctValueReachableError: 'Correct value must be reachable from minimum using the selectable step.',
      acceptedIntervalError: 'Accepted interval must contain at least one selectable slider position.'
    }
  };

  var decimalPlaces = function (value) {
    var parts = String(value).toLowerCase().split('e');
    var fraction = (parts[0].split('.')[1] || '').length;
    var exponent = parseInt(parts[1] || '0', 10);
    return Math.max(0, fraction - exponent);
  };

  var mergeParameters = function (params) {
    params = params || {};
    var behaviour = params.behaviour || {};
    var l10n = params.l10n || {};
    var merged = {};
    var key;

    for (key in DEFAULTS) {
      if (key !== 'behaviour' && key !== 'l10n') {
        merged[key] = params[key] !== undefined ? params[key] : DEFAULTS[key];
      }
    }
    merged.orientation = params.orientation === 'vertical' ? 'vertical' : 'horizontal';
    merged.scaleMode = params.scaleMode === 'customPoints' ? 'customPoints' : 'numerical';

    merged.behaviour = {};
    for (key in DEFAULTS.behaviour) {
      merged.behaviour[key] = behaviour[key] !== undefined ? behaviour[key] : DEFAULTS.behaviour[key];
    }
    if (Object.prototype.hasOwnProperty.call(behaviour, 'autoCheck')) {
      merged.behaviour.autoCheck = behaviour.autoCheck === true;
    }
    else if (Object.prototype.hasOwnProperty.call(behaviour, 'enableCheckButton')) {
      merged.behaviour.autoCheck = behaviour.enableCheckButton === false;
    }
    else {
      merged.behaviour.autoCheck = false;
    }

    merged.l10n = {};
    for (key in DEFAULTS.l10n) {
      merged.l10n[key] = l10n[key] !== undefined ? l10n[key] : DEFAULTS.l10n[key];
    }

    // Before singular and plural templates existed, one customizable template
    // used the English token "attempt(s)". Preserve authored legacy wording,
    // including after the editor injects the new English defaults.
    if (Object.prototype.hasOwnProperty.call(l10n, 'incorrectFeedback')) {
      var legacyIncorrectFeedback = typeof l10n.incorrectFeedback === 'string' ?
        l10n.incorrectFeedback : '';
      if (!Object.prototype.hasOwnProperty.call(l10n, 'incorrectFeedbackSingular') ||
          l10n.incorrectFeedbackSingular === DEFAULTS.l10n.incorrectFeedbackSingular) {
        merged.l10n.incorrectFeedbackSingular = legacyIncorrectFeedback.replace('attempt(s)', 'attempt');
      }
      if (!Object.prototype.hasOwnProperty.call(l10n, 'incorrectFeedbackPlural') ||
          l10n.incorrectFeedbackPlural === DEFAULTS.l10n.incorrectFeedbackPlural) {
        merged.l10n.incorrectFeedbackPlural = legacyIncorrectFeedback.replace('attempt(s)', 'attempts');
      }
    }

    return merged;
  };

  var createNumericalModel = function (params) {
    var values = [params.minimum, params.maximum, params.step, params.correctValue, params.acceptedTolerance];
    var precision = Math.max.apply(null, values.map(decimalPlaces));
    var factor = Math.pow(10, precision);
    var minimum = Math.round(params.minimum * factor);
    var maximum = Math.round(params.maximum * factor);
    var step = Math.round(params.step * factor);
    var correct = Math.round(params.correctValue * factor);
    var tolerance = Math.round(params.acceptedTolerance * factor);
    var span = maximum - minimum;
    var positionCount = step > 0 ? Math.floor(span / step) + 1 : 0;
    var lowerBound = tolerance > correct - minimum ? minimum : correct - tolerance;
    var upperBound = tolerance > maximum - correct ? maximum : correct + tolerance;
    var firstAcceptedIndex = step > 0 ? Math.max(0, Math.ceil((lowerBound - minimum) / step)) : -1;
    var lastAcceptedIndex = step > 0 ?
      Math.min(positionCount - 1, Math.floor((upperBound - minimum) / step)) : -1;
    var referenceIndex = step > 0 ? (correct - minimum) / step : -1;
    var solutionIndex = Math.max(firstAcceptedIndex, Math.min(lastAcceptedIndex, Math.round(referenceIndex)));

    return {
      mode: 'numerical',
      precision: precision,
      factor: factor,
      minimum: minimum,
      maximum: maximum,
      step: step,
      correct: correct,
      tolerance: tolerance,
      lowerBound: lowerBound,
      upperBound: upperBound,
      positionCount: positionCount,
      correctIndex: referenceIndex,
      firstAcceptedIndex: firstAcceptedIndex,
      lastAcceptedIndex: lastAcceptedIndex,
      solutionIndex: solutionIndex,
      signature: JSON.stringify([minimum, maximum, step, correct, tolerance])
    };
  };

  var normalizeCustomPoint = function (point) {
    return {
      value: typeof point.value === 'string' ? point.value.trim() : '',
      label: typeof point.label === 'string' ? point.label.trim() : '',
      correct: point.correct === true
    };
  };

  var createCustomModel = function (params) {
    var points = params.customPoints.map(normalizeCustomPoint);
    var correctIndex = points.findIndex(function (point) { return point.correct; });
    return {
      mode: 'customPoints',
      points: points,
      positionCount: points.length,
      correctIndex: correctIndex,
      signature: JSON.stringify(points)
    };
  };

  var createModel = function (params) {
    return params.scaleMode === 'customPoints' ? createCustomModel(params) : createNumericalModel(params);
  };

  var replaceToken = function (template, token, value) {
    return String(template).split(token).join(value);
  };

  var indexedMessage = function (template, index) {
    return replaceToken(template, '@index', index + 1);
  };

  var validateParameters = function (rawParams) {
    var params = mergeParameters(rawParams);
    var errors = [];
    if (!Number.isInteger(params.maxAttempts) || params.maxAttempts < 1) {
      errors.push(params.l10n.maxAttemptsError);
    }

    if (params.scaleMode === 'customPoints') {
      if (!Array.isArray(params.customPoints) || params.customPoints.length < 2 || params.customPoints.length > 12) {
        errors.push(params.l10n.customPointsCountError);
        return errors;
      }

      var correctCount = 0;
      params.customPoints.forEach(function (point, index) {
        if (!point || typeof point.value !== 'string' || point.value.trim() === '') {
          errors.push(indexedMessage(params.l10n.customPointValueRequiredError, index));
          return;
        }
        if (point.value.trim().length > 40) {
          errors.push(indexedMessage(params.l10n.customPointValueLengthError, index));
        }
        if (point.label !== undefined && point.label !== null && typeof point.label !== 'string') {
          errors.push(indexedMessage(params.l10n.customPointLabelTypeError, index));
        }
        else if (typeof point.label === 'string' && point.label.trim().length > 80) {
          errors.push(indexedMessage(params.l10n.customPointLabelLengthError, index));
        }
        if (point.correct === true) {
          correctCount++;
        }
      });
      if (correctCount !== 1) {
        errors.push(params.l10n.customPointCorrectCountError);
      }
      return errors;
    }

    var numericKeys = {
      minimum: 'minimumFiniteError',
      maximum: 'maximumFiniteError',
      step: 'stepFiniteError',
      correctValue: 'correctValueFiniteError',
      acceptedTolerance: 'acceptedToleranceFiniteError'
    };

    Object.keys(numericKeys).forEach(function (key) {
      if (typeof params[key] !== 'number' || !isFinite(params[key])) {
        errors.push(params.l10n[numericKeys[key]]);
      }
    });

    if (errors.length > 0) {
      return errors;
    }

    if (params.minimum >= params.maximum) {
      errors.push(params.l10n.minimumMaximumError);
    }
    if (params.step <= 0) {
      errors.push(params.l10n.stepPositiveError);
    }
    if (params.acceptedTolerance < 0) {
      errors.push(params.l10n.toleranceNonNegativeError);
    }
    if (params.correctValue < params.minimum || params.correctValue > params.maximum) {
      errors.push(params.l10n.correctValueRangeError);
    }
    if (errors.length > 0) {
      return errors;
    }

    var model = createNumericalModel(params);
    [model.minimum, model.maximum, model.step, model.correct, model.tolerance].forEach(function (value) {
      if (Math.abs(value) > MAX_SAFE_INTEGER) {
        errors.push(params.l10n.safeIntegerError);
      }
    });

    if (model.tolerance === 0 && (model.correct - model.minimum) % model.step !== 0) {
      errors.push(params.l10n.correctValueReachableError);
    }
    if (model.tolerance > 0 && model.firstAcceptedIndex > model.lastAcceptedIndex) {
      errors.push(params.l10n.acceptedIntervalError);
    }

    return errors;
  };

  var stripHtml = function (html) {
    return $('<div>').html(html || '').text();
  };

  var normalizeLanguageTag = function (languageTag) {
    if (typeof languageTag !== 'string') {
      return 'en';
    }

    var parts = languageTag.trim().split('-');
    if (!/^[A-Za-z]{2,3}$/.test(parts[0]) || parts.some(function (part, index) {
      return index > 0 && !/^[A-Za-z0-9]{2,8}$/.test(part);
    })) {
      return 'en';
    }

    return parts.map(function (part, index) {
      if (index === 0) {
        return part.toLowerCase();
      }
      if (/^[A-Za-z]{4}$/.test(part)) {
        return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
      }
      if (/^[A-Za-z]{2}$/.test(part) || /^\d{3}$/.test(part)) {
        return part.toUpperCase();
      }
      return part.toLowerCase();
    }).join('-');
  };

  /**
   * Numerical Scale Question with optional accepted tolerance.
   *
   * @class H5P.ScaleQuestion
   * @extends H5P.Question
   * @param {Object} params Author parameters.
   * @param {number} contentId Content identifier.
   * @param {Object} contentData H5P content metadata and previous state.
   */
  function ScaleQuestion(params, contentId, contentData) {
    Question.call(this, 'scale-question', { theme: true });

    this.params = mergeParameters(params);
    this.contentId = contentId;
    this.contentData = contentData || {};
    this.languageTag = normalizeLanguageTag(
      this.contentData.metadata && this.contentData.metadata.defaultLanguage
    );
    this.isTask = true;
    this.validationErrors = validateParameters(this.params);
    this.model = this.validationErrors.length === 0 ? createModel(this.params) : createModel(DEFAULTS);
    this.$scale = null;
    this.$slider = null;
    this.$sliderFrame = null;
    this.$valueBubbleTrack = null;
    this.$valueBubble = null;
    this.$pointList = null;
    this.$pointItems = [];
    this.$statusGroup = null;
    this.$valueStatus = null;
    this.$valueStatusIcon = null;
    this.$valueStatusText = null;
    this.$solutionStatus = null;
    this.$solutionStatusText = null;
    this.pointListId = 'h5p-scale-question-points-' + contentId;
    this.terminalEventEmitted = false;
    this.lastCommittedIndex = null;
    this.lastCommitTime = 0;

    this.setInitialState();
    this.restoreState(this.contentData.previousState);
  }

  ScaleQuestion.prototype = Object.create(Question.prototype);
  ScaleQuestion.prototype.constructor = ScaleQuestion;

  ScaleQuestion.validateParameters = validateParameters;

  ScaleQuestion.prototype.setInitialState = function () {
    this.cursorIndex = 0;
    this.selectedIndex = null;
    this.attemptsUsed = 0;
    this.awaitingRetry = false;
    this.terminal = false;
    this.correct = false;
    this.solutionVisible = false;
  };

  ScaleQuestion.prototype.restoreState = function (state) {
    if (!state || state.version !== STATE_VERSION || this.validationErrors.length > 0) {
      return;
    }

    if (this.model.mode === 'customPoints' && state.customPointSignature !== this.model.signature) {
      return;
    }
    if (this.model.mode === 'numerical' && state.numericalSignature !== this.model.signature) {
      return;
    }

    var lastIndex = this.model.positionCount - 1;
    if (Number.isInteger(state.cursorIndex)) {
      this.cursorIndex = Math.max(0, Math.min(lastIndex, state.cursorIndex));
    }
    if (state.selectedIndex === null || Number.isInteger(state.selectedIndex)) {
      this.selectedIndex = state.selectedIndex === null ? null : Math.max(0, Math.min(lastIndex, state.selectedIndex));
    }
    if (Number.isInteger(state.attemptsUsed)) {
      this.attemptsUsed = Math.max(0, Math.min(this.params.maxAttempts, state.attemptsUsed));
    }

    var restoreDisabledRetryAttempt = state.terminal !== true &&
      this.params.behaviour.enableRetry === false &&
      state.awaitingRetry === true && this.selectedIndex !== null && this.attemptsUsed > 0;
    this.terminal = state.terminal === true || restoreDisabledRetryAttempt;
    this.correct = this.terminal && this.isCorrectIndex(this.selectedIndex) &&
      (state.correct === true || restoreDisabledRetryAttempt);
    this.solutionVisible = state.solutionVisible === true;
    if (this.solutionVisible && this.selectedIndex !== null) {
      this.cursorIndex = this.selectedIndex;
    }
    this.awaitingRetry = this.params.behaviour.enableRetry !== false &&
      !this.terminal && !this.solutionVisible &&
      state.awaitingRetry === true && this.selectedIndex !== null &&
      this.attemptsUsed > 0 && this.attemptsUsed < this.params.maxAttempts;
    this.terminalEventEmitted = this.terminal;
  };

  ScaleQuestion.prototype.valueAt = function (index) {
    if (this.model.mode === 'customPoints') {
      return index;
    }
    return (this.model.minimum + index * this.model.step) / this.model.factor;
  };

  ScaleQuestion.prototype.formatScaledValue = function (scaledValue) {
    var value = scaledValue / this.model.factor;
    if (this.model.precision === 0) {
      return String(value);
    }
    return value.toFixed(this.model.precision).replace(/\.?0+$/, '');
  };

  ScaleQuestion.prototype.formatValue = function (index) {
    if (this.model.mode === 'customPoints') {
      var point = this.model.points[index];
      if (!point) {
        return '';
      }
      return point.value + (point.label ? ' — ' + point.label : '');
    }
    return this.formatScaledValue(this.model.minimum + index * this.model.step);
  };

  ScaleQuestion.prototype.isCorrectIndex = function (index) {
    if (!Number.isInteger(index)) {
      return false;
    }
    if (this.model.mode === 'customPoints') {
      return index === this.model.correctIndex;
    }
    return index >= this.model.firstAcceptedIndex && index <= this.model.lastAcceptedIndex;
  };

  ScaleQuestion.prototype.getSliderLabel = function () {
    return this.model.mode === 'customPoints' ? this.params.l10n.customScaleLabel : this.params.l10n.scaleLabel;
  };

  ScaleQuestion.prototype.createSlider = function ($parent, isVertical) {
    var self = this;
    this.$slider = $('<input>', {
      'class': 'h5p-scale-question-slider',
      'type': 'range',
      'min': 0,
      'max': this.model.positionCount - 1,
      'step': 1,
      'value': this.cursorIndex,
      'aria-label': this.getSliderLabel(),
      'aria-orientation': this.params.orientation
    }).appendTo($parent);
    if (isVertical) {
      this.$slider.attr('orient', 'vertical');
    }
    if (this.model.mode === 'customPoints') {
      this.$slider.attr('aria-describedby', this.pointListId);
    }
    this.$slider.on('pointerdown touchstart', function () { self.beginSelectionGesture(); });
    this.$slider.on('input', function () { self.handleSliderInput(); });
    this.$slider.on('pointerup mouseup', function () { self.commitCursor(); });
    this.$slider.on('touchend', function () { self.commitCursor(); });
    this.$slider.on('click', function () { self.commitCursor(); });
    this.$slider.on('change', function () { self.commitCursor(); });
    this.$slider.on('keydown', function (event) { self.handleKeyDown(event); });
  };

  ScaleQuestion.prototype.createPointList = function (reverseOrder) {
    var self = this;
    var indices = this.model.points.map(function (point, index) { return index; });
    if (reverseOrder) {
      indices.reverse();
    }
    this.$pointList = $('<div>', {
      'class': 'h5p-scale-question-points h5p-scale-question-points-' + this.params.orientation,
      'id': this.pointListId,
      'role': 'list',
      'style': '--h5p-scale-point-count: ' + this.model.positionCount
    });
    indices.forEach(function (index) {
      var point = self.model.points[index];
      var $item = $('<div>', {
        'class': 'h5p-scale-question-point',
        'role': 'listitem',
        'data-index': index
      }).appendTo(self.$pointList);
      $('<span>', {
        'class': 'h5p-scale-question-point-value',
        'text': point.value
      }).appendTo($item);
      if (point.label) {
        $('<span>', {
          'class': 'h5p-scale-question-point-label',
          'text': point.label
        }).appendTo($item);
      }
      self.$pointItems[index] = $item;
    });
    return this.$pointList;
  };

  ScaleQuestion.prototype.registerNumericalScale = function (isVertical) {
    var $minimum = $('<span>', {
      'class': 'h5p-scale-question-bound h5p-scale-question-minimum',
      'text': this.formatValue(0)
    });
    var $maximum = $('<span>', {
      'class': 'h5p-scale-question-bound h5p-scale-question-maximum',
      'text': this.formatValue(this.model.positionCount - 1)
    });
    (isVertical ? $maximum : $minimum).appendTo(this.$scale);
    this.$sliderFrame = $('<div>', {
      'class': 'h5p-scale-question-slider-frame h5p-scale-question-slider-frame-' + this.params.orientation
    }).appendTo(this.$scale);
    this.$valueBubbleTrack = $('<div>', {
      'class': 'h5p-scale-question-value-bubble-track h5p-scale-question-value-bubble-track-' +
        this.params.orientation,
      'aria-hidden': 'true'
    }).appendTo(this.$sliderFrame);
    this.$valueBubble = $('<span>', {
      'class': 'h5p-scale-question-value-bubble',
      'text': this.formatValue(this.cursorIndex)
    }).appendTo(this.$valueBubbleTrack);
    this.createSlider(this.$sliderFrame, isVertical);
    (isVertical ? $minimum : $maximum).appendTo(this.$scale);
  };

  ScaleQuestion.prototype.registerCustomScale = function (isVertical) {
    if (isVertical) {
      var $frame = $('<div>', {
        'class': 'h5p-scale-question-custom-frame-vertical'
      }).appendTo(this.$scale);
      this.createPointList(false).appendTo($frame);
      this.createSlider($frame, true);
      return;
    }

    var minimumWidth = Math.max(18, this.model.positionCount * 7);
    var $viewport = $('<div>', {
      'class': 'h5p-scale-question-custom-viewport'
    }).appendTo(this.$scale);
    var $inner = $('<div>', {
      'class': 'h5p-scale-question-custom-inner',
      'style': '--h5p-scale-point-count: ' + this.model.positionCount + '; min-width: ' + minimumWidth + 'rem'
    }).appendTo($viewport);
    this.createSlider($inner, false);
    this.$slider.attr('style', 'padding-inline: ' + (50 / this.model.positionCount) + '%');
    this.createPointList(true).appendTo($inner);
  };

  ScaleQuestion.prototype.registerDomElements = function () {
    var self = this;

    this.registerMedia();

    if (this.params.question) {
      this.setIntroduction(this.params.question);
    }

    if (this.validationErrors.length > 0) {
      this.setContent($('<div>', {
        'class': 'h5p-scale-question-configuration-error',
        'role': 'alert',
        'text': this.params.l10n.configurationErrorPrefix + ' ' + this.validationErrors.join(' ')
      }));
      return;
    }

    var isVertical = this.params.orientation === 'vertical';
    var $wrapper = $('<div>', {
      'class': 'h5p-scale-question-numerical h5p-scale-question-' + this.params.orientation +
        ' h5p-scale-question-mode-' + this.model.mode
    });
    this.$scale = $('<div>', {
      'class': 'h5p-scale-question-slider-layout h5p-scale-question-slider-layout-' + this.params.orientation +
        (this.model.mode === 'customPoints' ? ' h5p-scale-question-slider-layout-custom' : '')
    }).appendTo($wrapper);

    if (this.model.mode === 'customPoints') {
      this.registerCustomScale(isVertical);
    }
    else {
      this.registerNumericalScale(isVertical);
    }

    this.$statusGroup = $('<div>', {
      'class': 'h5p-scale-question-status-group',
      'role': 'status',
      'aria-live': 'polite'
    }).appendTo($wrapper);
    this.$valueStatus = $('<div>', {
      'class': 'h5p-scale-question-value-status'
    }).appendTo(this.$statusGroup);
    this.$valueStatusIcon = $('<span>', {
      'class': 'h5p-scale-question-feedback-icon',
      'aria-hidden': 'true'
    }).appendTo(this.$valueStatus);
    this.$valueStatusText = $('<span>', {
      'class': 'h5p-scale-question-value-status-text'
    }).appendTo(this.$valueStatus);
    this.$solutionStatus = $('<div>', {
      'class': 'h5p-scale-question-value-status h5p-scale-question-solution-status'
    }).appendTo(this.$statusGroup);
    this.$solutionStatusText = $('<span>', {
      'class': 'h5p-scale-question-value-status-text'
    }).appendTo(this.$solutionStatus);

    this.setContent($wrapper);
    this.addButton('check-answer', this.params.l10n.checkAnswer, function () {
      self.checkAnswer();
    }, false, {}, { icon: 'check' });
    this.addButton('try-again', this.params.l10n.tryAgain, function () {
      self.retryTask(true);
    }, false, {}, { styleType: 'secondary', icon: 'retry' });
    this.addButton('show-solution', this.params.l10n.showSolution, function () {
      self.showSolutions();
    }, false, {}, { styleType: 'secondary', icon: 'show-solutions' });
    this.on('resize', function () {
      self.positionValueBubble();
    });
    this.updateView();
    if (this.awaitingRetry) {
      this.setFeedback(
        this.getIntermediateIncorrectFeedback(),
        0, MAX_SCORE, this.params.l10n.scoreBarLabel
      );
    }
  };

  /**
   * Register optional media through H5P.Question's standard media sections.
   * Invalid or incomplete media data is ignored safely.
   */
  ScaleQuestion.prototype.registerMedia = function () {
    var mediaGroup = this.params.media;
    if (!mediaGroup || !mediaGroup.type || !mediaGroup.type.library || !mediaGroup.type.params) {
      return;
    }

    var media = mediaGroup.type;
    var type = media.library.split(' ')[0];
    if (type === 'H5P.Image' && media.params.file && media.params.file.path) {
      this.setImage(media.params.file.path, {
        disableImageZooming: mediaGroup.disableImageZooming || false,
        alt: media.params.alt,
        title: media.params.title,
        expandImage: media.params.expandImage,
        minimizeImage: media.params.minimizeImage
      });
    }
    else if (type === 'H5P.Video' && media.params.sources) {
      this.setVideo(media);
    }
    else if (type === 'H5P.Audio' && media.params.files) {
      this.setAudio(media);
    }
  };

  ScaleQuestion.prototype.handleKeyDown = function (event) {
    var key = event.key || event.code;
    var nextIndex = this.cursorIndex;
    var isCustom = this.model.mode === 'customPoints';
    var isVertical = this.params.orientation === 'vertical';

    if (isCustom && isVertical && (key === 'ArrowUp' || key === 'ArrowLeft')) {
      nextIndex--;
    }
    else if (isCustom && isVertical && (key === 'ArrowDown' || key === 'ArrowRight')) {
      nextIndex++;
    }
    else if (isCustom && !isVertical && (key === 'ArrowLeft' || key === 'ArrowDown')) {
      nextIndex++;
    }
    else if (isCustom && !isVertical && (key === 'ArrowRight' || key === 'ArrowUp')) {
      nextIndex--;
    }
    else if (!isCustom && (key === 'ArrowLeft' || key === 'ArrowDown')) {
      nextIndex--;
    }
    else if (!isCustom && (key === 'ArrowRight' || key === 'ArrowUp')) {
      nextIndex++;
    }
    else if (key === 'Home') {
      nextIndex = isCustom && !isVertical ? this.model.positionCount - 1 : 0;
    }
    else if (key === 'End') {
      nextIndex = isCustom && !isVertical ? 0 : this.model.positionCount - 1;
    }
    else if (key === 'Enter' || key === ' ' || key === 'Spacebar') {
      if (event.preventDefault) {
        event.preventDefault();
      }
      this.commitCursor();
      return;
    }
    else {
      return;
    }

    if (event.preventDefault) {
      event.preventDefault();
    }
    this.moveCursor(nextIndex, true);
  };

  ScaleQuestion.prototype.sliderIndex = function () {
    var index = this.$slider ? Math.round(parseFloat(this.$slider.val())) : this.cursorIndex;
    return Number.isInteger(index) ? index : this.cursorIndex;
  };

  ScaleQuestion.prototype.handleSliderInput = function () {
    this.moveCursor(this.sliderIndex());
  };

  ScaleQuestion.prototype.beginSelectionGesture = function () {
    this.lastCommittedIndex = null;
    this.lastCommitTime = 0;
  };

  ScaleQuestion.prototype.moveCursor = function (index, moveFocus) {
    if (this.terminal || this.solutionVisible || this.awaitingRetry || this.validationErrors.length > 0) {
      if (this.$slider) {
        this.$slider.val(this.cursorIndex);
      }
      return;
    }

    var nextIndex = Math.max(0, Math.min(this.model.positionCount - 1, index));
    if (this.selectedIndex !== null && this.selectedIndex !== nextIndex) {
      this.selectedIndex = null;
    }
    this.cursorIndex = nextIndex;
    this.updateView();
    if (moveFocus && this.$slider) {
      this.$slider.focus();
    }
  };

  /**
   * Commit a pointer, touch, or keyboard release once. Browsers may emit
   * overlapping pointer/mouse/change events for one physical gesture.
   */
  ScaleQuestion.prototype.commitCursor = function () {
    if (this.terminal || this.solutionVisible || this.awaitingRetry || this.validationErrors.length > 0) {
      if (this.$slider) {
        this.$slider.val(this.cursorIndex);
      }
      return false;
    }

    this.moveCursor(this.sliderIndex());
    var now = Date.now();
    if (this.lastCommittedIndex === this.cursorIndex && now - this.lastCommitTime < 500) {
      return false;
    }
    this.lastCommittedIndex = this.cursorIndex;
    this.lastCommitTime = now;
    this.selectPosition(this.cursorIndex);
    return true;
  };

  ScaleQuestion.prototype.selectPosition = function (index) {
    if (this.terminal || this.solutionVisible || this.awaitingRetry || this.validationErrors.length > 0) {
      return;
    }

    this.cursorIndex = Math.max(0, Math.min(this.model.positionCount - 1, index));
    this.selectedIndex = this.cursorIndex;
    this.updateView();

    if (this.params.behaviour.autoCheck) {
      this.checkAnswer();
    }
  };

  ScaleQuestion.prototype.positionValueBubble = function () {
    if (!this.$valueBubble || !this.$valueBubbleTrack || !this.$sliderFrame) {
      return;
    }

    var lastIndex = this.model.positionCount - 1;
    var displayIndex = this.solutionVisible ? this.model.solutionIndex : this.cursorIndex;
    var ratio = lastIndex > 0 ? displayIndex / lastIndex : 0;
    var isVertical = this.params.orientation === 'vertical';
    var position = (isVertical ? 1 - ratio : ratio) * 100;
    this.$valueBubble.attr('style', (isVertical ? 'top: ' : 'left: ') + position + '%');

    var bubble = this.$valueBubble[0];
    var track = this.$valueBubbleTrack[0];
    var frame = this.$sliderFrame[0];
    var slider = this.$slider && this.$slider[0];
    if (!bubble || !track || !frame || !slider || !bubble.getBoundingClientRect ||
        !track.getBoundingClientRect || !frame.getBoundingClientRect || !slider.getBoundingClientRect) {
      return;
    }

    var bubbleRect = bubble.getBoundingClientRect();
    var trackRect = track.getBoundingClientRect();
    var frameRect = frame.getBoundingClientRect();
    var sliderRect = slider.getBoundingClientRect();
    var thumbSize = 16;
    if (typeof window !== 'undefined' && window.getComputedStyle) {
      ['::-webkit-slider-thumb', '::-moz-range-thumb'].some(function (pseudo) {
        try {
          var style = window.getComputedStyle(slider, pseudo);
          var candidate = parseFloat(isVertical ? style.height : style.width);
          if (candidate > 0 && candidate <= 64) {
            thumbSize = candidate;
            return true;
          }
        }
        catch (error) {
          return false;
        }
        return false;
      });
    }
    if (isVertical && trackRect.height > 0 && bubbleRect.height > 0) {
      var verticalTravel = Math.max(0, sliderRect.height - thumbSize);
      var targetY = sliderRect.top + thumbSize / 2 + (1 - ratio) * verticalTravel;
      targetY = Math.max(frameRect.top + bubbleRect.height / 2,
        Math.min(frameRect.bottom - bubbleRect.height / 2, targetY));
      this.$valueBubble.attr('style', 'top: ' + (targetY - trackRect.top) + 'px');
    }
    else if (!isVertical && trackRect.width > 0 && bubbleRect.width > 0) {
      var horizontalTravel = Math.max(0, sliderRect.width - thumbSize);
      var targetX = sliderRect.left + thumbSize / 2 + ratio * horizontalTravel;
      targetX = Math.max(frameRect.left + bubbleRect.width / 2,
        Math.min(frameRect.right - bubbleRect.width / 2, targetX));
      this.$valueBubble.attr('style', 'left: ' + (targetX - trackRect.left) + 'px');
    }
  };

  ScaleQuestion.prototype.updateValueBubble = function () {
    if (!this.$valueBubble) {
      return;
    }
    var displayIndex = this.solutionVisible ? this.model.solutionIndex : this.cursorIndex;
    this.$valueBubble.text(this.formatValue(displayIndex));
    this.positionValueBubble();
    if (typeof window !== 'undefined' && window.requestAnimationFrame) {
      var self = this;
      window.requestAnimationFrame(function () {
        self.positionValueBubble();
      });
    }
  };

  ScaleQuestion.prototype.updateView = function () {
    var selectionEvaluated = this.selectedIndex !== null && (this.awaitingRetry || this.terminal);
    var selectionCorrect = selectionEvaluated && this.isCorrectIndex(this.selectedIndex);
    var selectionIncorrect = selectionEvaluated && !selectionCorrect;
    var cursorStatus = this.params.l10n.cursorValue.replace('@value', this.formatValue(this.cursorIndex));
    var selectedStatus = this.selectedIndex === null ? '' :
      this.params.l10n.selectedValue.replace('@value', this.formatValue(this.selectedIndex));
    var status = this.selectedIndex === null ? cursorStatus : selectedStatus;
    var solutionStatus = '';
    if (this.solutionVisible) {
      var solutionIndex = this.model.mode === 'customPoints' ?
        this.model.correctIndex : this.model.solutionIndex;
      solutionStatus = this.params.l10n.correctAnswer.replace('@value', this.formatValue(solutionIndex));
      status = selectedStatus ? selectedStatus + '. ' + solutionStatus : solutionStatus;
    }

    if (this.$slider) {
      var interactionLocked = this.terminal || this.solutionVisible || this.awaitingRetry;
      this.$slider
        .val(this.cursorIndex)
        .attr('aria-valuemin', this.valueAt(0))
        .attr('aria-valuemax', this.valueAt(this.model.positionCount - 1))
        .attr('aria-valuenow', this.valueAt(this.cursorIndex))
        .attr('aria-valuetext', status)
        .attr('aria-disabled', interactionLocked ? 'true' : 'false')
        .prop('disabled', interactionLocked)
        .toggleClass('h5p-scale-question-selected', this.selectedIndex !== null)
        .toggleClass('h5p-scale-question-disabled', interactionLocked);
    }

    this.updateValueBubble();
    if (this.$valueBubble) {
      this.$valueBubble
        .toggleClass('h5p-scale-question-value-bubble-selected', this.selectedIndex !== null)
        .toggleClass('h5p-scale-question-feedback-correct', !this.solutionVisible && selectionCorrect)
        .toggleClass('h5p-scale-question-feedback-incorrect', !this.solutionVisible && selectionIncorrect)
        .toggleClass('h5p-scale-question-value-bubble-solution', this.solutionVisible);
    }

    this.$pointItems.forEach(function ($point, index) {
      $point
        .attr('aria-current', index === this.cursorIndex ? 'true' : 'false')
        .toggleClass('h5p-scale-question-point-cursor', index === this.cursorIndex)
        .toggleClass('h5p-scale-question-point-selected', index === this.selectedIndex)
        .toggleClass('h5p-scale-question-feedback-correct', selectionCorrect && index === this.selectedIndex)
        .toggleClass('h5p-scale-question-feedback-incorrect', selectionIncorrect && index === this.selectedIndex)
        .toggleClass('h5p-scale-question-point-solution', this.solutionVisible && index === this.model.correctIndex);
    }, this);

    if (this.$valueStatus) {
      var hideNumericalCursorStatus = this.model.mode === 'numerical' &&
        this.selectedIndex === null && !this.solutionVisible;
      var valueStatus = this.solutionVisible ? selectedStatus : status;
      var hideValueStatus = this.solutionVisible ? this.selectedIndex === null : hideNumericalCursorStatus;
      this.$valueStatus
        .toggleClass('h5p-scale-question-value-status-empty', hideValueStatus)
        .toggleClass('h5p-scale-question-value-status-selected', this.selectedIndex !== null)
        .toggleClass('h5p-scale-question-feedback-correct', selectionCorrect)
        .toggleClass('h5p-scale-question-feedback-incorrect', selectionIncorrect);
      this.$valueStatusText.text(hideValueStatus ? '' : valueStatus);
      this.$valueStatusIcon
        .toggleClass('h5p-scale-question-feedback-icon-correct', selectionCorrect)
        .toggleClass('h5p-scale-question-feedback-icon-incorrect', selectionIncorrect);
      this.$solutionStatus
        .toggleClass('h5p-scale-question-value-status-empty', !this.solutionVisible)
        .toggleClass('h5p-scale-question-feedback-correct', this.solutionVisible);
      this.$solutionStatusText.text(solutionStatus);
    }
    this.updateButtons();
  };

  ScaleQuestion.prototype.updateButtons = function () {
    if (!this.hasButton || this.validationErrors.length > 0) {
      return;
    }

    var canCheck = !this.params.behaviour.autoCheck &&
      this.selectedIndex !== null && !this.terminal && !this.solutionVisible && !this.awaitingRetry;
    var canRetry = this.params.behaviour.enableRetry &&
      this.awaitingRetry;
    var canShowSolution = this.params.behaviour.enableSolutionsButton &&
      this.terminal && !this.correct &&
      (this.attemptsUsed >= this.params.maxAttempts || this.params.behaviour.enableRetry === false) &&
      !this.solutionVisible;

    canCheck ? this.showButton('check-answer') : this.hideButton('check-answer');
    canRetry ? this.showButton('try-again') : this.hideButton('try-again');
    canShowSolution ? this.showButton('show-solution') : this.hideButton('show-solution');
  };

  ScaleQuestion.prototype.getDirectionalFeedback = function () {
    if (this.selectedIndex === null || this.isCorrectIndex(this.selectedIndex)) {
      return '';
    }

    var isBelow = this.model.mode === 'customPoints' ?
      this.selectedIndex > this.model.correctIndex :
      this.model.minimum + this.selectedIndex * this.model.step < this.model.lowerBound;
    var feedback = isBelow ? this.params.feedbackBelowCorrect : this.params.feedbackAboveCorrect;
    return typeof feedback === 'string' ? feedback.trim() : '';
  };

  ScaleQuestion.prototype.getCorrectFeedback = function () {
    var feedback = typeof this.params.l10n.correctFeedback === 'string' ?
      this.params.l10n.correctFeedback : '';
    var selectedValue = this.model.mode === 'numerical' && Number.isInteger(this.selectedIndex) ?
      this.model.minimum + this.selectedIndex * this.model.step : null;

    if (this.model.mode !== 'numerical' || this.model.tolerance <= 0 ||
        !this.isCorrectIndex(this.selectedIndex) || selectedValue === this.model.correct) {
      return feedback;
    }

    feedback = feedback.trim();
    var explanation = replaceToken(
      this.params.l10n.acceptedToleranceFeedback,
      '@tolerance',
      this.formatScaledValue(this.model.tolerance)
    );
    if (!feedback) {
      return explanation;
    }

    return feedback + (/[.!?:;]$/.test(feedback) ? ' ' : '. ') + explanation;
  };

  ScaleQuestion.prototype.getIncorrectFeedback = function () {
    var remaining = this.params.maxAttempts - this.attemptsUsed;
    var template = remaining === 1 ?
      this.params.l10n.incorrectFeedbackSingular :
      this.params.l10n.incorrectFeedbackPlural;
    return replaceToken(template, '@remaining', remaining);
  };

  ScaleQuestion.prototype.getIntermediateIncorrectFeedback = function () {
    var directionalFeedback = this.getDirectionalFeedback();
    var attemptFeedback = this.getIncorrectFeedback();

    if (!directionalFeedback) {
      return attemptFeedback;
    }

    return '<div class="h5p-scale-question-feedback-parts">' +
      '<div class="h5p-scale-question-directional-feedback">' + directionalFeedback + '</div>' +
      '<div class="h5p-scale-question-attempt-feedback">' + attemptFeedback + '</div>' +
      '</div>';
  };

  ScaleQuestion.prototype.checkAnswer = function () {
    if (this.selectedIndex === null || this.terminal || this.solutionVisible || this.awaitingRetry ||
        this.validationErrors.length > 0) {
      return false;
    }

    this.attemptsUsed++;
    var isCorrect = this.isCorrectIndex(this.selectedIndex);
    var attemptsExhausted = this.attemptsUsed >= this.params.maxAttempts;
    var retryDisabled = this.params.behaviour.enableRetry === false;

    if (isCorrect || attemptsExhausted || retryDisabled) {
      this.terminal = true;
      this.correct = isCorrect;
    }
    else {
      this.awaitingRetry = true;
    }

    this.updateView();
    if (this.terminal) {
      this.setFeedback(
        this.correct ? this.getCorrectFeedback() : this.params.l10n.terminalIncorrectFeedback,
        this.getScore(), MAX_SCORE, this.params.l10n.scoreBarLabel
      );
      this.emitTerminalAnswered();
    }
    else {
      this.setFeedback(
        this.getIntermediateIncorrectFeedback(),
        0, MAX_SCORE, this.params.l10n.scoreBarLabel
      );
    }
    return this.terminal;
  };

  ScaleQuestion.prototype.addQuestionToXAPI = function (xAPIEvent) {
    var definition = xAPIEvent.getVerifiedStatementValue(['object', 'definition']);
    definition.description = {};
    definition.description[this.languageTag] = stripHtml(this.params.question);
    definition.type = 'http://adlnet.gov/expapi/activities/cmi.interaction';
    if (this.model.mode === 'customPoints') {
      definition.interactionType = 'choice';
      var languageTag = this.languageTag;
      definition.choices = this.model.points.map(function (point, index) {
        var choice = {
          id: 'point-' + index,
          description: {}
        };
        choice.description[languageTag] = point.value + (point.label ? ' — ' + point.label : '');
        return choice;
      });
      definition.correctResponsesPattern = ['point-' + this.model.correctIndex];
    }
    else {
      definition.interactionType = 'numeric';
      definition.correctResponsesPattern = this.model.tolerance === 0 ?
        [this.formatScaledValue(this.model.correct)] :
        [this.formatValue(this.model.firstAcceptedIndex) + '[:]' +
          this.formatValue(this.model.lastAcceptedIndex)];
    }
  };

  ScaleQuestion.prototype.createAnsweredEvent = function () {
    var xAPIEvent = this.createXAPIEventTemplate('answered');
    this.addQuestionToXAPI(xAPIEvent);
    xAPIEvent.setScoredResult(
      this.getScore(), MAX_SCORE, this, this.terminal,
      this.terminal ? this.correct : undefined
    );
    if (this.selectedIndex !== null) {
      xAPIEvent.data.statement.result.response = this.model.mode === 'customPoints' ?
        'point-' + this.selectedIndex : this.formatValue(this.selectedIndex);
    }
    return xAPIEvent;
  };

  ScaleQuestion.prototype.emitTerminalAnswered = function () {
    if (!this.terminal || this.terminalEventEmitted) {
      return;
    }
    this.terminalEventEmitted = true;
    this.trigger(this.createAnsweredEvent());
  };

  ScaleQuestion.prototype.getAnswerGiven = function () { return this.terminal; };
  ScaleQuestion.prototype.getScore = function () { return this.terminal && this.correct ? MAX_SCORE : 0; };
  ScaleQuestion.prototype.getMaxScore = function () { return MAX_SCORE; };
  ScaleQuestion.prototype.isPassed = function () { return this.terminal && this.correct; };
  ScaleQuestion.prototype.isCompleted = function () { return this.terminal; };

  ScaleQuestion.prototype.getCurrentState = function () {
    var state = {
      version: STATE_VERSION,
      cursorIndex: this.cursorIndex,
      selectedIndex: this.selectedIndex,
      attemptsUsed: this.attemptsUsed,
      awaitingRetry: this.awaitingRetry,
      terminal: this.terminal,
      correct: this.correct,
      solutionVisible: this.solutionVisible
    };
    if (this.model.mode === 'customPoints') {
      state.customPointSignature = this.model.signature;
    }
    else {
      state.numericalSignature = this.model.signature;
    }
    return state;
  };

  ScaleQuestion.prototype.showSolutions = function () {
    if (this.validationErrors.length > 0) {
      return;
    }
    this.solutionVisible = true;
    this.updateView();
  };

  ScaleQuestion.prototype.retryTask = function (moveFocus) {
    if (this.params.behaviour.enableRetry === false || !this.awaitingRetry || this.terminal ||
        this.validationErrors.length > 0) {
      return;
    }

    this.cursorIndex = 0;
    this.selectedIndex = null;
    this.awaitingRetry = false;
    this.correct = false;
    this.solutionVisible = false;
    this.lastCommittedIndex = null;
    this.lastCommitTime = 0;
    if (this.removeFeedback) {
      this.removeFeedback();
    }
    this.updateView();
    if (moveFocus && this.$slider) {
      this.$slider.focus();
    }
  };

  ScaleQuestion.prototype.resetTask = function (moveFocus) {
    this.setInitialState();
    this.terminalEventEmitted = false;
    this.lastCommittedIndex = null;
    this.lastCommitTime = 0;
    if (this.removeFeedback) {
      this.removeFeedback();
    }
    this.updateView();
    if (moveFocus && this.$slider) {
      this.$slider.focus();
    }
  };

  ScaleQuestion.prototype.getXAPIData = function () {
    return { statement: this.createAnsweredEvent().data.statement };
  };

  ScaleQuestion.prototype.getTitle = function () {
    var title = this.contentData.metadata && this.contentData.metadata.title ?
      this.contentData.metadata.title : this.params.l10n.defaultTitle;
    return H5P.createTitle ? H5P.createTitle(title) : title;
  };

  return ScaleQuestion;
})(H5P.jQuery, H5P.Question);
