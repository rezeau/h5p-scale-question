'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'library.json'), 'utf8'));
const semantics = JSON.parse(fs.readFileSync(path.join(root, 'semantics.json'), 'utf8'));
const frenchPath = path.join(root, 'language', 'fr.json');
const frenchSource = fs.readFileSync(frenchPath, 'utf8');
const french = JSON.parse(frenchSource);
const scriptPath = path.join(root, 'scripts', 'scale-question.js');
const source = fs.readFileSync(scriptPath, 'utf8');
const cssSource = fs.readFileSync(path.join(root, 'styles', 'scale-question.css'), 'utf8');
const readmeSource = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const iconSource = fs.readFileSync(path.join(root, 'icon.svg'), 'utf8');

const cssDeclarationsFor = (selector) => {
  const marker = `${selector} {`;
  const start = cssSource.indexOf(marker);
  assert.notEqual(start, -1, `Missing CSS rule for ${selector}`);
  const end = cssSource.indexOf('}', start);
  return Object.fromEntries(
    [...cssSource.slice(start + marker.length, end).matchAll(/([\w-]+)\s*:\s*([^;]+);/g)]
      .map((match) => [match[1], match[2].trim()])
  );
};

const resolveThemeValue = (value, variables = {}) => value.replace(
  /var\((--[\w-]+),\s*([^)]+)\)/g,
  (match, name, fallback) => variables[name] || fallback.trim()
);

const plain = (value) => JSON.parse(JSON.stringify(value));

const combinedIncorrectFeedback = (directional, remaining) =>
  '<div class="h5p-scale-question-feedback-parts">' +
  '<div class="h5p-scale-question-directional-feedback">' + directional + '</div>' +
  '<div class="h5p-scale-question-attempt-feedback">Incorrect. ' + remaining +
  ' attempt' + (remaining === 1 ? '' : 's') + ' remaining.</div>' +
  '</div>';

const validParams = (overrides = {}) => ({
  question: '<p>Choose two</p>',
  minimum: 0,
  maximum: 4,
  step: 1,
  correctValue: 2,
  maxAttempts: 2,
  behaviour: {
    autoCheck: false,
    enableRetry: true,
    enableSolutionsButton: true,
    ...(overrides.behaviour || {})
  },
  ...overrides,
  ...(overrides.behaviour ? { behaviour: {
    autoCheck: false,
    enableRetry: true,
    enableSolutionsButton: true,
    ...overrides.behaviour
  }} : {})
});

const customPoints = () => ([
  { value: 'Freezing', label: 'Very cold', correct: false },
  { value: 'Cold', label: 'Low temperature', correct: false },
  { value: 'Warm', label: 'Comfortable', correct: true },
  { value: 'Hot', label: '', correct: false }
]);

const validCustomParams = (overrides = {}) => validParams({
  scaleMode: 'customPoints',
  customPoints: customPoints(),
  ...overrides
});

class FakeElement {
  constructor(tag, attributes = {}) {
    this.tag = tag;
    this.attributes = { ...attributes };
    this.properties = {};
    this.handlers = {};
    this.children = [];
    this.classes = new Set((attributes.class || '').split(/\s+/).filter(Boolean));
    this.textValue = attributes.text || '';
    this.htmlValue = '';
    this.focused = false;
  }

  appendTo(parent) {
    parent.children.push(this);
    return this;
  }

  on(events, handler) {
    events.split(/\s+/).forEach((event) => {
      this.handlers[event] = this.handlers[event] || [];
      this.handlers[event].push(handler);
    });
    return this;
  }

  triggerEvent(event, data = {}) {
    (this.handlers[event] || []).forEach((handler) => handler.call(this, data));
    return this;
  }

  attr(name, value) {
    if (value === undefined) {
      return this.attributes[name];
    }
    this.attributes[name] = value;
    return this;
  }

  prop(name, value) {
    if (value === undefined) {
      return this.properties[name];
    }
    this.properties[name] = value;
    return this;
  }

  val(value) {
    if (value === undefined) {
      return this.attributes.value;
    }
    this.attributes.value = value;
    return this;
  }

  toggleClass(name, enabled) {
    enabled ? this.classes.add(name) : this.classes.delete(name);
    return this;
  }

  text(value) {
    if (value === undefined) {
      return this.textValue + this.children.map((child) => child.text()).join('');
    }
    this.textValue = value;
    return this;
  }

  html(value) {
    if (value === undefined) {
      return this.htmlValue;
    }
    this.htmlValue = value;
    this.textValue = String(value).replace(/<[^>]*>/g, '');
    return this;
  }

  focus() {
    this.focused = true;
    return this.triggerEvent('focus');
  }
}

class FakeXAPIEvent {
  constructor(verb) {
    this.data = {
      statement: {
        verb: { id: `http://adlnet.gov/expapi/verbs/${verb}` },
        object: { definition: {} }
      }
    };
  }

  getVerb() {
    return this.data.statement.verb.id.split('/').pop();
  }

  getVerifiedStatementValue(pathParts) {
    let value = this.data.statement;
    pathParts.forEach((part) => {
      value[part] = value[part] || {};
      value = value[part];
    });
    return value;
  }

  setScoredResult(score, maxScore, instance, completion, success) {
    this.data.statement.result = {
      score: {
        min: 0,
        max: maxScore,
        raw: score,
        scaled: maxScore > 0 ? score / maxScore : undefined
      },
      completion
    };
    if (success !== undefined) {
      this.data.statement.result.success = success;
    }
  }

  getScore() {
    return this.data.statement.result?.score?.raw ?? null;
  }

  getMaxScore() {
    return this.data.statement.result?.score?.max ?? null;
  }
}

function createRuntime() {
  const calls = {
    questionConstructor: [],
    introductions: [],
    contents: [],
    events: [],
    feedback: [],
    feedbackRemoved: 0,
    buttons: {},
    media: [],
    registrationOrder: []
  };

  function Question(type, options) {
    calls.questionConstructor.push({ type, options });
    this.listeners = {};
    this.setImage = (mediaPath, options) => {
      calls.media.push({ type: 'image', path: mediaPath, options });
      calls.registrationOrder.push('media');
      calls.simulateImageLoad = () => {
        this.trigger('imageLoaded');
        this.trigger('resize');
      };
    };
    this.setVideo = (media) => {
      calls.media.push({ type: 'video', media });
      calls.registrationOrder.push('media');
      calls.simulateVideoResize = () => this.trigger('resize');
    };
    this.setAudio = (media) => {
      calls.media.push({ type: 'audio', media });
      calls.registrationOrder.push('media');
    };
    this.setIntroduction = (introduction) => {
      calls.introductions.push(introduction);
      calls.registrationOrder.push('introduction');
    };
    this.setContent = (content) => {
      calls.contents.push(content);
      calls.registrationOrder.push('content');
    };
    this.addButton = (id, label, callback, visible) => {
      calls.buttons[id] = { label, callback, visible };
    };
    this.hasButton = (id) => !!calls.buttons[id];
    this.showButton = (id) => {
      if (calls.buttons[id]) calls.buttons[id].visible = true;
    };
    this.hideButton = (id) => {
      if (calls.buttons[id]) calls.buttons[id].visible = false;
    };
    this.setFeedback = (...args) => {
      calls.feedback.push(args);
      this.trigger('resize');
    };
    this.removeFeedback = () => { calls.feedbackRemoved++; };
    this.createXAPIEventTemplate = (verb) => new FakeXAPIEvent(verb);
    this.on = (event, handler) => {
      this.listeners[event] = this.listeners[event] || [];
      this.listeners[event].push(handler);
    };
    this.trigger = (event) => {
      calls.events.push(event);
      const name = event instanceof FakeXAPIEvent ? 'xAPI' : event;
      (this.listeners[name] || []).forEach((handler) => handler.call(this, event));
    };
    this.attach = (container) => {
      this.registerDomElements();
      container.attached = true;
    };
  }

  function jquery(tag, attributes) {
    return new FakeElement(tag, attributes);
  }

  const context = {
    H5P: {
      jQuery: jquery,
      Question,
      createTitle: (title) => title
    }
  };
  vm.createContext(context);
  new vm.Script(source, { filename: scriptPath }).runInContext(context);
  return { H5P: context.H5P, calls };
}

function createInstance(params = validParams(), contentData = {}) {
  const runtime = createRuntime();
  const instance = new runtime.H5P.ScaleQuestion(params, 42, contentData);
  return { ...runtime, instance };
}

function attach(instance) {
  const container = {};
  instance.attach(container);
  return container;
}

function xAPIEvents(calls) {
  return calls.events.filter((event) => event instanceof FakeXAPIEvent);
}

// Reproduces H5PEditor.processSemanticsChunk's default insertion for groups.
function applyEditorDefaults(fields, params) {
  fields.forEach((field) => {
    if (params[field.name] === undefined && field.default !== undefined) {
      params[field.name] = field.default;
    }
    if (field.type === 'group' && params[field.name] !== undefined) {
      applyEditorDefaults(field.fields, params[field.name]);
    }
  });
  return params;
}

test('library identity and asset paths are consistent', () => {
  assert.equal(manifest.title, 'Scale Question');
  assert.equal(manifest.machineName, 'H5P.ScaleQuestion');
  assert.deepEqual([manifest.majorVersion, manifest.minorVersion, manifest.patchVersion], [0, 1, 0]);
  assert.equal(manifest.runnable, 1);
  assert.ok(fs.existsSync(path.join(root, manifest.preloadedJs[0].path)));
  assert.ok(fs.existsSync(path.join(root, manifest.preloadedCss[0].path)));
  assert.deepEqual(manifest.preloadedDependencies, [{
    machineName: 'H5P.Question', majorVersion: 1, minorVersion: 5
  }]);
  assert.deepEqual(manifest.editorDependencies, [{
    machineName: 'H5PEditor.ShowWhen', majorVersion: 1, minorVersion: 0
  }]);
});

test('editor schema exposes numerical and ordered custom-point modes', () => {
  assert.deepEqual(semantics.map((field) => field.name), [
    'media', 'question', 'scaleMode', 'minimum', 'maximum', 'step', 'correctValue', 'acceptedTolerance',
    'customPoints', 'feedbackBelowCorrect', 'feedbackAboveCorrect',
    'maxAttempts', 'orientation', 'behaviour', 'l10n'
  ]);
  const media = semantics.find((field) => field.name === 'media');
  const mediaType = media.fields.find((field) => field.name === 'type');
  assert.equal(mediaType.optional, true);
  assert.deepEqual(mediaType.options, ['H5P.Image 1.1', 'H5P.Video 1.6', 'H5P.Audio 1.5']);
  const scaleMode = semantics.find((field) => field.name === 'scaleMode');
  assert.equal(scaleMode.default, 'numerical');
  assert.deepEqual(scaleMode.options, [
    { value: 'numerical', label: 'Numerical scale' },
    { value: 'customPoints', label: 'Custom points' }
  ]);
  ['minimum', 'maximum', 'step', 'correctValue', 'acceptedTolerance'].forEach((name) => {
    const field = semantics.find((item) => item.name === name);
    assert.equal(field.widget, 'showWhen');
    assert.equal(field.showWhen.rules[0].equals, 'numerical');
  });
  const correctValue = semantics.find((field) => field.name === 'correctValue');
  assert.equal(correctValue.name, 'correctValue');
  assert.equal(correctValue.label, 'Correct answer');
  const tolerance = semantics.find((field) => field.name === 'acceptedTolerance');
  assert.equal(tolerance.label, 'Accepted tolerance (±)');
  assert.equal(tolerance.default, 0);
  assert.equal(tolerance.min, 0);
  assert.equal(tolerance.optional, true);
  assert.match(tolerance.description, /inclusive interval/i);
  assert.match(tolerance.description, /zero requires an exact selectable answer/i);
  assert.match(tolerance.description, /correct answer/i);
  const points = semantics.find((field) => field.name === 'customPoints');
  assert.equal(points.type, 'list');
  assert.equal(points.min, 2);
  assert.equal(points.max, 12);
  assert.equal(points.widget, 'showWhen');
  assert.match(points.description, /you control the point order/i);
  assert.match(points.description, /highest\/latest at the top.*lowest\/earliest at the bottom/i);
  assert.match(points.description, /vertical.*top to bottom/i);
  assert.match(points.description, /horizontal.*reverse.*left to right/i);
  assert.match(points.description, /vertical orientation.*more than approximately six points.*long point labels/i);
  assert.deepEqual(points.field.fields.map((field) => field.name), ['value', 'label', 'correct']);
  assert.equal(points.field.fields[0].maxLength, 40);
  assert.equal(points.field.fields[1].maxLength, 80);
  const belowFeedback = semantics.find((field) => field.name === 'feedbackBelowCorrect');
  const aboveFeedback = semantics.find((field) => field.name === 'feedbackAboveCorrect');
  assert.equal(belowFeedback.type, 'text');
  assert.equal(belowFeedback.optional, true);
  assert.match(belowFeedback.description, /too low or too early/i);
  assert.equal(aboveFeedback.type, 'text');
  assert.equal(aboveFeedback.optional, true);
  assert.match(aboveFeedback.description, /too high or too late/i);
  const orientation = semantics.find((field) => field.name === 'orientation');
  assert.equal(orientation.type, 'select');
  assert.equal(orientation.label, 'Slider orientation');
  assert.equal(orientation.default, 'horizontal');
  assert.deepEqual(orientation.options, [
    { value: 'horizontal', label: 'Horizontal' },
    { value: 'vertical', label: 'Vertical' }
  ]);
  const l10n = semantics.find((field) => field.name === 'l10n');
  const correctAnswer = l10n.fields.find((field) => field.name === 'correctAnswer');
  assert.equal(correctAnswer.default, 'Correct answer: @value');
  assert.deepEqual(
    l10n.fields
      .filter((field) => [
        'correctValueFiniteError',
        'correctValueRangeError',
        'correctValueReachableError'
      ].includes(field.name))
      .map((field) => [field.name, field.label, field.default]),
    [
      ['correctValueFiniteError', 'Invalid correct answer error', 'Correct answer must be a finite number.'],
      ['correctValueRangeError', 'Correct answer outside domain error', 'Correct answer must be within the selectable domain.'],
      ['correctValueReachableError', 'Unreachable exact answer error', 'Correct answer must be reachable from minimum using the selectable step.']
    ]
  );
  assert.doesNotMatch(JSON.stringify(semantics), /reference[ -]answer|correct value/i);
  assert.doesNotMatch(readmeSource, /reference[ -]answer|correct value/i);
  assert.match(readmeSource, /reference points/i);
  const forbidden = /opinion|survey|self[- ]?assessment|ungraded|likert|preference|historical|ordinal/i;
  assert.equal(forbidden.test(JSON.stringify(semantics)), false);
});

test('library icon uses the standard H5P canvas with centered vector artwork', () => {
  const rootTag = iconSource.match(/<svg\b[^>]*>/)[0];
  assert.match(rootTag, /viewBox="0 0 400 225"/);
  assert.doesNotMatch(rootTag, /\s(?:width|height)=/);
  assert.match(iconSource, /<g transform="translate\(100 12\.5\) scale\(0\.78125\)">/);
  assert.doesNotMatch(iconSource, /<(?:image|script)\b/i);
  assert.doesNotMatch(iconSource, /\b(?:href|src)=/i);
});

test('automatic-check authoring field uses the approved semantics and keeps legacy input hidden', () => {
  const behaviour = semantics.find((field) => field.name === 'behaviour');
  const autoCheck = behaviour.fields.find((field) => field.name === 'autoCheck');
  const legacy = behaviour.fields.find((field) => field.name === 'enableCheckButton');
  assert.deepEqual(autoCheck, {
    name: 'autoCheck',
    type: 'boolean',
    label: 'Automatically check answers after selection',
    description: "When enabled, the learner's answer is checked immediately after selecting a value or point. The Check button is not displayed. When disabled, the learner must click Check to submit an answer.",
    default: false
  });
  assert.equal(legacy.widget, 'none');
  assert.equal(legacy.label, undefined);
  assert.equal(legacy.optional, true);
  assert.equal(legacy.default, undefined);
});

test('question without media registers introduction before scale content', () => {
  const { instance, calls } = createInstance();
  attach(instance);
  assert.deepEqual(calls.media, []);
  assert.deepEqual(calls.registrationOrder, ['introduction', 'content']);
});

test('image media uses H5P.Question options and is registered above the question', () => {
  const media = {
    type: {
      library: 'H5P.Image 1.1',
      params: {
        file: { path: 'images/example.png' },
        alt: 'A useful diagram',
        title: 'Diagram',
        expandImage: 'Expand image',
        minimizeImage: 'Minimize image'
      }
    },
    disableImageZooming: true
  };
  const { instance, calls } = createInstance(validParams({ media }));
  attach(instance);
  assert.equal(calls.media.length, 1);
  assert.equal(calls.media[0].type, 'image');
  assert.equal(calls.media[0].path, 'images/example.png');
  assert.deepEqual(plain(calls.media[0].options), {
    disableImageZooming: true,
    alt: 'A useful diagram',
    title: 'Diagram',
    expandImage: 'Expand image',
    minimizeImage: 'Minimize image'
  });
  assert.deepEqual(calls.registrationOrder, ['media', 'introduction', 'content']);
});

test('video and audio media use the standard H5P.Question APIs', () => {
  const video = {
    type: {
      library: 'H5P.Video 1.6',
      params: { sources: [{ path: 'video/example.mp4', mime: 'video/mp4' }] }
    }
  };
  const videoRuntime = createInstance(validParams({ media: video }));
  attach(videoRuntime.instance);
  assert.equal(videoRuntime.calls.media[0].type, 'video');
  assert.equal(videoRuntime.calls.media[0].media, video.type);
  assert.deepEqual(videoRuntime.calls.registrationOrder, ['media', 'introduction', 'content']);

  const audio = {
    type: {
      library: 'H5P.Audio 1.5',
      params: { files: [{ path: 'audio/example.mp3', mime: 'audio/mpeg' }] }
    }
  };
  const audioRuntime = createInstance(validParams({ media: audio }));
  attach(audioRuntime.instance);
  assert.equal(audioRuntime.calls.media[0].type, 'audio');
  assert.equal(audioRuntime.calls.media[0].media, audio.type);
  assert.deepEqual(audioRuntime.calls.registrationOrder, ['media', 'introduction', 'content']);
});

test('missing, incomplete, and unsupported media are ignored safely', () => {
  const invalidMedia = [
    {},
    { type: {} },
    { type: { library: 'H5P.Image 1.1', params: {} } },
    { type: { library: 'H5P.Video 1.6', params: {} } },
    { type: { library: 'H5P.Audio 1.5', params: {} } },
    { type: { library: 'H5P.Unknown 1.0', params: { file: { path: 'x' } } } }
  ];

  invalidMedia.forEach((media) => {
    const { instance, calls } = createInstance(validParams({ media }));
    assert.doesNotThrow(() => attach(instance));
    assert.deepEqual(calls.media, []);
    assert.deepEqual(calls.registrationOrder, ['introduction', 'content']);
  });
});

test('media has no effect on scoring, xAPI, reset, or restored state', () => {
  const media = {
    type: {
      library: 'H5P.Image 1.1',
      params: { file: { path: 'images/example.png' }, alt: 'Diagram' }
    }
  };
  const { instance, calls } = createInstance(validParams({ media }));
  attach(instance);
  instance.selectPosition(2);
  instance.checkAnswer();
  assert.equal(instance.getScore(), 1);
  assert.equal(xAPIEvents(calls).length, 1);
  instance.resetTask();
  assert.equal(instance.getAnswerGiven(), false);
  assert.equal(instance.getScore(), 0);
  assert.equal(xAPIEvents(calls).length, 1);

  const restored = createInstance(validParams({ media }), {
    previousState: {
      version: 1, cursorIndex: 1, selectedIndex: 1, attemptsUsed: 1,
      terminal: false, correct: false, solutionVisible: false
    }
  });
  attach(restored.instance);
  assert.equal(restored.instance.getAnswerGiven(), false);
  assert.equal(xAPIEvents(restored.calls).length, 0);
});

test('authoring validation rejects invalid domains, answers, steps, and attempts', () => {
  const { H5P } = createRuntime();
  assert.deepEqual(plain(H5P.ScaleQuestion.validateParameters(validParams())), []);
  assert.match(H5P.ScaleQuestion.validateParameters(validParams({ minimum: 4 }))[0], /less than maximum/i);
  assert.match(H5P.ScaleQuestion.validateParameters(validParams({ step: 0 }))[0], /positive/i);
  assert.match(H5P.ScaleQuestion.validateParameters(validParams({ correctValue: 5 }))[0], /within/i);
  assert.match(H5P.ScaleQuestion.validateParameters(validParams({ step: 2, correctValue: 1 }))[0], /reachable/i);
  assert.deepEqual(plain(H5P.ScaleQuestion.validateParameters(validParams({ maximum: 5, step: 2, correctValue: 2 }))), []);
  assert.match(H5P.ScaleQuestion.validateParameters(validParams({ maxAttempts: 1.5 }))[0], /positive integer/i);
});

test('numerical mode remains the default for older content', () => {
  const params = validParams();
  delete params.scaleMode;
  const { instance } = createInstance(params);
  attach(instance);
  assert.equal(instance.params.scaleMode, 'numerical');
  assert.equal(instance.model.mode, 'numerical');
  assert.equal(instance.model.correctIndex, 2);
  assert.equal(instance.$slider.attributes['aria-label'], 'Numerical scale');
});

test('custom-point validation requires 2-12 complete points and exactly one correct point', () => {
  const { H5P } = createRuntime();
  assert.deepEqual(plain(H5P.ScaleQuestion.validateParameters(validCustomParams())), []);
  assert.match(H5P.ScaleQuestion.validateParameters(validCustomParams({ customPoints: [
    { value: 'Only', correct: true }
  ] }))[0], /between 2 and 12/i);
  assert.match(H5P.ScaleQuestion.validateParameters(validCustomParams({ customPoints: [
    { value: '', correct: true }, { value: 'Valid', correct: false }
  ] }))[0], /requires a value/i);
  assert.match(H5P.ScaleQuestion.validateParameters(validCustomParams({ customPoints: [
    { value: 'A', correct: false }, { value: 'B', correct: false }
  ] })).at(-1), /exactly one/i);
  assert.match(H5P.ScaleQuestion.validateParameters(validCustomParams({ customPoints: [
    { value: 'A', correct: true }, { value: 'B', correct: true }
  ] })).at(-1), /exactly one/i);
});

test('invalid custom configuration renders an error instead of choosing another answer', () => {
  const { instance, calls } = createInstance(validCustomParams({ customPoints: [
    { value: 'Duplicate', correct: true },
    { value: 'Duplicate', correct: true }
  ] }));
  attach(instance);
  assert.match(calls.contents[0].textValue, /exactly one custom point/i);
  assert.equal(instance.$slider, null);
  assert.equal(instance.getScore(), 0);
});

test('custom model preserves author order and assigns equally spaced indices', () => {
  const authored = [
    { value: '1905', label: 'Cubism', correct: false },
    { value: '1845', label: 'Pre-Raphaelites', correct: true },
    { value: '1925', label: 'Surrealism', correct: false },
    { value: '1885', label: 'Impressionism', correct: false }
  ];
  const { instance } = createInstance(validCustomParams({ customPoints: authored }));
  attach(instance);
  assert.deepEqual(plain(instance.model.points.map((point) => point.value)), ['1905', '1845', '1925', '1885']);
  assert.equal(instance.model.positionCount, 4);
  assert.equal(instance.model.correctIndex, 1);
  assert.equal(instance.$slider.attributes.min, 0);
  assert.equal(instance.$slider.attributes.max, 3);
  assert.equal(instance.$slider.attributes.step, 1);
});

test('horizontal custom points show reverse authored order from last-left to first-right', () => {
  const { instance } = createInstance(validCustomParams());
  attach(instance);
  assert.equal(instance.$slider.attributes['aria-label'], 'Custom-point scale');
  assert.equal(instance.$slider.attributes['aria-describedby'], instance.pointListId);
  assert.deepEqual(instance.$pointList.children.map((item) => item.children[0].textValue), [
    'Hot', 'Warm', 'Cold', 'Freezing'
  ]);
  assert.deepEqual(instance.$pointList.children.map((item) => item.attributes['data-index']), [3, 2, 1, 0]);
  assert.equal(instance.$pointList.children[0].children.length, 1);
  assert.equal(instance.$pointList.children[3].children[1].textValue, 'Very cold');
  assert.match(instance.$slider.attributes.style, /padding-inline:\s*12\.5%/);
  assert.ok(instance.$pointList.classes.has('h5p-scale-question-points-horizontal'));
  assert.match(cssSource, /grid-template-columns:\s*repeat\(var\(--h5p-scale-point-count\)/);
  assert.match(cssSource, /h5p-scale-question-custom-inner\s*>\s*\.h5p-scale-question-slider\s*\{[\s\S]*?direction:\s*rtl/);
  assert.match(cssSource, /overflow-x:\s*auto/);
});

test('vertical custom points show first at top and last at bottom', () => {
  const { instance } = createInstance(validCustomParams({ orientation: 'vertical' }));
  attach(instance);
  assert.deepEqual(instance.$pointList.children.map((item) => item.children[0].textValue), [
    'Freezing', 'Cold', 'Warm', 'Hot'
  ]);
  assert.deepEqual(instance.$pointList.children.map((item) => item.attributes['data-index']), [0, 1, 2, 3]);
  assert.deepEqual(plain(instance.$pointItems.map((item) => item.attributes['data-index'])), [0, 1, 2, 3]);
  assert.equal(instance.$slider.attributes['aria-orientation'], 'vertical');
  assert.equal(instance.$slider.attributes.orient, 'vertical');
  assert.match(cssSource, /h5p-scale-question-custom-frame-vertical[\s\S]*?height:\s*100%/);
  assert.match(cssSource, /h5p-scale-question-custom-frame-vertical\s*>\s*\.h5p-scale-question-slider\s*\{[\s\S]*?direction:\s*ltr/);
  assert.match(cssSource, /grid-template-rows:\s*repeat\(var\(--h5p-scale-point-count\),\s*minmax\(3\.5rem,\s*1fr\)\)/);
  assert.doesNotMatch(cssSource, /h5p-scale-question-custom-frame-vertical[\s\S]*?\d+(?:\.\d+)?vh/);
});

test('custom point indicators use borders without underlining label text', () => {
  const cursorRule = cssSource.match(/\.h5p-scale-question-point-cursor\s*\{([^}]*)\}/)[1];
  const selectedRule = cssSource.match(/\.h5p-scale-question-point-selected\s*\{([^}]*)\}/)[1];
  const solutionRule = cssSource.match(/\.h5p-scale-question-point-solution\s*\{([^}]*)\}/)[1];
  const focusRule = cssSource.match(/\.h5p-scale-question-slider:focus-visible\s*\{([^}]*)\}/)[1];

  assert.match(cursorRule, /outline:\s*2px dashed/);
  assert.doesNotMatch(cursorRule, /text-decoration/);
  assert.match(selectedRule, /border-color:/);
  assert.match(solutionRule, /outline:\s*3px double/);
  assert.match(focusRule, /outline:\s*3px solid/);
});

test('duplicate custom values remain unambiguous because correctness uses position', () => {
  const duplicatePoints = [
    { value: 'Same', label: 'First', correct: false },
    { value: 'Same', label: 'Second', correct: true },
    { value: 'Same', label: 'Third', correct: false }
  ];
  const { instance, calls } = createInstance(validCustomParams({ customPoints: duplicatePoints }));
  attach(instance);
  instance.selectPosition(1);
  instance.checkAnswer();
  assert.equal(instance.getScore(), 1);
  const event = xAPIEvents(calls)[0];
  assert.equal(event.data.statement.object.definition.interactionType, 'choice');
  assert.equal(event.data.statement.result.response, 'point-1');
  assert.deepEqual(plain(event.data.statement.object.definition.correctResponsesPattern), ['point-1']);
  assert.deepEqual(plain(event.data.statement.object.definition.choices.map((choice) => choice.id)), [
    'point-0', 'point-1', 'point-2'
  ]);
});

test('decimal positions use stable integer indices and numeric xAPI values', () => {
  const { instance, calls } = createInstance(validParams({
    minimum: 0.1, maximum: 0.5, step: 0.1, correctValue: 0.3
  }));
  assert.equal(instance.model.correctIndex, 2);
  assert.equal(instance.valueAt(2), 0.3);
  assert.equal(instance.formatValue(2), '0.3');
  assert.equal(instance.model.positionCount, 5);
  attach(instance);
  instance.selectPosition(2);
  instance.checkAnswer();
  assert.equal(xAPIEvents(calls)[0].data.statement.result.response, '0.3');
  assert.deepEqual(
    plain(xAPIEvents(calls)[0].data.statement.object.definition.correctResponsesPattern),
    ['0.3']
  );
});

test('missing and zero tolerance preserve exact-answer validation and scoring', () => {
  const { H5P } = createRuntime();
  const missing = validParams();
  delete missing.acceptedTolerance;
  assert.deepEqual(plain(H5P.ScaleQuestion.validateParameters(missing)), []);
  assert.match(H5P.ScaleQuestion.validateParameters(validParams({
    step: 2,
    correctValue: 1,
    acceptedTolerance: 0
  }))[0], /correct answer.*reachable/i);

  [missing, validParams({ acceptedTolerance: 0 })].forEach((params) => {
    const { instance, calls } = createInstance(params);
    attach(instance);
    assert.equal(instance.model.tolerance, 0);
    assert.equal(instance.model.firstAcceptedIndex, 2);
    assert.equal(instance.model.lastAcceptedIndex, 2);
    instance.selectPosition(2);
    instance.checkAnswer();
    assert.equal(instance.getScore(), 1);
    assert.deepEqual(
      plain(xAPIEvents(calls)[0].data.statement.object.definition.correctResponsesPattern),
      ['2']
    );
  });
});

test('positive tolerance accepts every selectable position in its inclusive interval', () => {
  const params = validParams({
    minimum: 4000,
    maximum: 5000,
    step: 10,
    correctValue: 4806,
    acceptedTolerance: 100
  });
  const { instance } = createInstance(params);
  attach(instance);
  assert.equal(instance.model.lowerBound, 4706);
  assert.equal(instance.model.upperBound, 4906);
  assert.equal(instance.model.firstAcceptedIndex, 71);
  assert.equal(instance.model.lastAcceptedIndex, 90);
  assert.equal(instance.valueAt(71), 4710);
  assert.equal(instance.valueAt(90), 4900);
  assert.equal(instance.isCorrectIndex(70), false);
  assert.equal(instance.isCorrectIndex(71), true);
  assert.equal(instance.isCorrectIndex(80), true);
  assert.equal(instance.isCorrectIndex(90), true);
  assert.equal(instance.isCorrectIndex(91), false);
  assert.equal(instance.model.correctIndex, 80.6);
});

test('decimal tolerance, clipped intervals, and non-aligned maximum use exact scaled integers', () => {
  const decimal = createInstance(validParams({
    minimum: 0.1,
    maximum: 0.6,
    step: 0.1,
    correctValue: 0.35,
    acceptedTolerance: 0.15
  })).instance;
  assert.equal(decimal.model.factor, 100);
  assert.equal(decimal.model.lowerBound, 20);
  assert.equal(decimal.model.upperBound, 50);
  assert.equal(decimal.model.firstAcceptedIndex, 1);
  assert.equal(decimal.model.lastAcceptedIndex, 4);
  assert.equal(decimal.valueAt(1), 0.2);
  assert.equal(decimal.valueAt(4), 0.5);

  const clippedMinimum = createInstance(validParams({
    minimum: 0, maximum: 10, step: 2, correctValue: 1, acceptedTolerance: 3
  })).instance;
  assert.equal(clippedMinimum.model.lowerBound, 0);
  assert.equal(clippedMinimum.model.upperBound, 4);
  assert.equal(clippedMinimum.model.firstAcceptedIndex, 0);
  assert.equal(clippedMinimum.model.lastAcceptedIndex, 2);

  const clippedMaximum = createInstance(validParams({
    minimum: 0, maximum: 10, step: 2, correctValue: 9, acceptedTolerance: 3
  })).instance;
  assert.equal(clippedMaximum.model.lowerBound, 6);
  assert.equal(clippedMaximum.model.upperBound, 10);
  assert.equal(clippedMaximum.model.firstAcceptedIndex, 3);
  assert.equal(clippedMaximum.model.lastAcceptedIndex, 5);

  const nonAlignedMaximum = createInstance(validParams({
    minimum: 0, maximum: 10, step: 3, correctValue: 8, acceptedTolerance: 2
  })).instance;
  assert.equal(nonAlignedMaximum.model.positionCount, 4);
  assert.equal(nonAlignedMaximum.valueAt(3), 9);
  assert.equal(nonAlignedMaximum.model.firstAcceptedIndex, 2);
  assert.equal(nonAlignedMaximum.model.lastAcceptedIndex, 3);
});

test('tolerance validation rejects invalid values and intervals without selectable positions', () => {
  const { H5P } = createRuntime();
  assert.match(H5P.ScaleQuestion.validateParameters(validParams({ acceptedTolerance: -1 }))[0], /non-negative/i);
  assert.match(H5P.ScaleQuestion.validateParameters(validParams({ acceptedTolerance: Infinity }))[0], /finite/i);
  assert.match(H5P.ScaleQuestion.validateParameters(validParams({ acceptedTolerance: NaN }))[0], /finite/i);
  assert.match(H5P.ScaleQuestion.validateParameters(validParams({ correctValue: 5 }))[0], /within/i);
  assert.match(H5P.ScaleQuestion.validateParameters(validParams({
    minimum: 0,
    maximum: 1,
    step: 2,
    correctValue: 1,
    acceptedTolerance: 0.05
  })).at(-1), /at least one selectable/i);
});

test('constructor initializes the H5P.Question subclass and task identity', () => {
  const { H5P, instance, calls } = createInstance();
  assert.ok(instance instanceof H5P.Question);
  assert.equal(instance.isTask, true);
  assert.equal(instance.getMaxScore(), 1);
  assert.equal(calls.questionConstructor[0].type, 'scale-question');
  assert.equal(calls.questionConstructor[0].options.theme, true);
});

test('attach renders a scale while the initial cursor remains unanswered', () => {
  const { instance, calls } = createInstance();
  const container = attach(instance);
  assert.equal(container.attached, true);
  assert.equal(instance.$slider.tag, '<input>');
  assert.equal(instance.$slider.attributes.type, 'range');
  assert.equal(instance.$slider.attributes.min, 0);
  assert.equal(instance.$slider.attributes.max, 4);
  assert.equal(instance.$slider.attributes.step, 1);
  assert.equal(instance.$slider.attributes['aria-label'], 'Numerical scale');
  assert.equal(instance.params.orientation, 'horizontal');
  assert.equal(instance.$slider.attributes['aria-orientation'], 'horizontal');
  assert.equal(instance.$slider.attributes.orient, undefined);
  assert.ok(instance.$scale.classes.has('h5p-scale-question-slider-layout-horizontal'));
  assert.equal(instance.$scale.children[0].textValue, '0');
  assert.equal(instance.$scale.children[2].textValue, '4');
  assert.equal(instance.cursorIndex, 0);
  assert.equal(instance.selectedIndex, null);
  assert.equal(instance.getAnswerGiven(), false);
  assert.equal(calls.buttons['check-answer'].visible, false);
  assert.equal(xAPIEvents(calls).length, 0);
});

test('numerical value bubble appears initially and custom-point mode omits it', () => {
  const numerical = createInstance(validParams({ minimum: 10, maximum: 20, step: 2, correctValue: 14 }));
  attach(numerical.instance);
  assert.equal(numerical.instance.$valueBubble.text(), '10');
  assert.equal(numerical.instance.$valueStatus.text(), '');
  assert.ok(numerical.instance.$valueStatus.classes.has('h5p-scale-question-value-status-empty'));
  assert.match(numerical.instance.$slider.attributes['aria-valuetext'], /Cursor at 10/);
  assert.equal(numerical.instance.$valueBubble.attributes['aria-live'], undefined);
  assert.equal(numerical.instance.$valueBubbleTrack.attributes['aria-hidden'], 'true');

  const custom = createInstance(validCustomParams());
  attach(custom.instance);
  assert.equal(custom.instance.$valueBubble, null);
  assert.equal(custom.instance.$valueBubbleTrack, null);
  assert.match(custom.instance.$valueStatus.text(), /Cursor at Freezing/);
  assert.equal(custom.instance.$valueStatus.classes.has('h5p-scale-question-value-status-empty'), false);
});

test('numerical value bubble shows formatted values and cursor movement has no answer side effects', () => {
  const { instance, calls } = createInstance(validParams({
    minimum: -1,
    maximum: 1,
    step: 0.25,
    correctValue: 0.5
  }));
  attach(instance);
  instance.moveCursor(5);
  assert.equal(instance.$valueBubble.text(), '0.25');
  assert.equal(instance.$valueStatus.text(), '');
  assert.match(instance.$slider.attributes['aria-valuetext'], /Cursor at 0\.25/);
  assert.equal(instance.cursorIndex, 5);
  assert.equal(instance.selectedIndex, null);
  assert.equal(instance.attemptsUsed, 0);
  assert.equal(instance.getScore(), 0);
  assert.equal(instance.getAnswerGiven(), false);
  assert.equal(xAPIEvents(calls).length, 0);

  instance.selectPosition(6);
  assert.equal(instance.$valueBubble.text(), '0.5');
  assert.match(instance.$valueStatus.text(), /Selected value: 0\.5/);
  assert.equal(instance.$valueStatus.classes.has('h5p-scale-question-value-status-empty'), false);
  assert.equal(instance.selectedIndex, 6);
  assert.equal(instance.attemptsUsed, 0);
});

test('numerical status hides only cursor text and preserves recorded-answer and solution displays', () => {
  const { instance } = createInstance(validParams({
    minimum: 0,
    maximum: 10,
    step: 2,
    correctValue: 5,
    acceptedTolerance: 1
  }));
  attach(instance);
  instance.moveCursor(1);
  assert.equal(instance.$valueStatus.text(), '');
  assert.match(instance.$slider.attributes['aria-valuetext'], /Cursor at 2/);

  instance.selectPosition(1);
  assert.equal(instance.$valueStatus.text(), 'Selected value: 2');
  assert.ok(instance.$slider.classes.has('h5p-scale-question-selected'));

  instance.showSolutions();
  assert.equal(instance.$valueStatus.text(), 'Selected value: 2');
  assert.equal(instance.$solutionStatus.text(), 'Correct answer: 6');
  assert.equal(instance.$valueStatus.classes.has('h5p-scale-question-value-status-empty'), false);
  assert.match(cssSource, /\.h5p-scale-question-value-status-empty\s*\{[^}]*min-height:\s*0;[^}]*margin-top:\s*0/);
});

test('numerical value bubble follows Show Solution, Retry, and Reset', () => {
  const { instance } = createInstance(validParams({
    minimum: 0,
    maximum: 10,
    step: 2,
    correctValue: 6
  }));
  attach(instance);
  instance.selectPosition(1);
  instance.checkAnswer();
  instance.showSolutions();
  assert.equal(instance.$valueBubble.text(), '6');

  instance.resetTask(true);
  assert.equal(instance.$valueBubble.text(), '0');
  assert.equal(instance.cursorIndex, 0);
  assert.equal(instance.selectedIndex, null);

  instance.moveCursor(4);
  instance.resetTask();
  assert.equal(instance.$valueBubble.text(), '0');
});

test('restored numerical cursor is reflected in the value bubble', () => {
  const params = validParams({ minimum: 100, maximum: 200, step: 25, correctValue: 150 });
  const original = createInstance(params);
  original.instance.moveCursor(3);
  const restored = createInstance(params, { previousState: plain(original.instance.getCurrentState()) });
  attach(restored.instance);
  assert.equal(restored.instance.cursorIndex, 3);
  assert.equal(restored.instance.$valueBubble.text(), '175');
  assert.equal(restored.instance.$valueStatus.text(), '');
  assert.match(restored.instance.$slider.attributes['aria-valuetext'], /Cursor at 175/);

  original.instance.selectPosition(2);
  const restoredSelection = createInstance(params, {
    previousState: plain(original.instance.getCurrentState())
  });
  attach(restoredSelection.instance);
  assert.equal(restoredSelection.instance.cursorIndex, 2);
  assert.equal(restoredSelection.instance.selectedIndex, 2);
  assert.equal(restoredSelection.instance.$valueBubble.text(), '150');
  assert.equal(restoredSelection.instance.$valueStatus.text(), 'Selected value: 150');
});

test('value bubble uses orientation-specific handle travel and endpoint clamping styles', () => {
  ['horizontal', 'vertical'].forEach((orientation) => {
    const { instance } = createInstance(validParams({ orientation }));
    attach(instance);
    assert.ok(instance.$sliderFrame.classes.has(`h5p-scale-question-slider-frame-${orientation}`));
    assert.ok(instance.$valueBubbleTrack.classes.has(`h5p-scale-question-value-bubble-track-${orientation}`));
    instance.moveCursor(instance.model.positionCount - 1);
    assert.match(instance.$valueBubble.attr('style'), orientation === 'vertical' ? /top:\s*0%/ : /left:\s*100%/);
  });

  assert.match(cssSource, /value-bubble-track-horizontal[\s\S]*?margin-inline:\s*calc\(var\(--h5p-scale-question-thumb-size\)\s*\/\s*2\)/);
  assert.match(cssSource, /value-bubble-track-vertical[\s\S]*?margin-block:\s*calc\(var\(--h5p-scale-question-thumb-size\)\s*\/\s*2\)/);
  assert.match(cssSource, /value-bubble-track-horizontal[\s\S]*?translateX\(-50%\)/);
  assert.match(cssSource, /value-bubble-track-vertical[\s\S]*?translateY\(-50%\)/);
});

test('value bubble clamps rendered endpoint positions inside its frame', () => {
  const exposeRect = (element, rect) => {
    element[0] = element;
    element.getBoundingClientRect = () => rect;
  };

  const horizontal = createInstance(validParams());
  attach(horizontal.instance);
  exposeRect(horizontal.instance.$sliderFrame, { left: 100, right: 300, top: 0, bottom: 60, width: 200, height: 60 });
  exposeRect(horizontal.instance.$valueBubbleTrack, { left: 108, right: 292, top: 0, bottom: 28, width: 184, height: 28 });
  exposeRect(horizontal.instance.$slider, { left: 100, right: 300, top: 28, bottom: 60, width: 200, height: 32 });
  exposeRect(horizontal.instance.$valueBubble, { left: 0, right: 60, top: 0, bottom: 20, width: 60, height: 20 });
  horizontal.instance.moveCursor(0);
  assert.equal(horizontal.instance.$valueBubble.attr('style'), 'left: 22px');
  horizontal.instance.moveCursor(horizontal.instance.model.positionCount - 1);
  assert.equal(horizontal.instance.$valueBubble.attr('style'), 'left: 162px');

  const vertical = createInstance(validParams({ orientation: 'vertical' }));
  attach(vertical.instance);
  exposeRect(vertical.instance.$sliderFrame, { left: 0, right: 160, top: 50, bottom: 250, width: 160, height: 200 });
  exposeRect(vertical.instance.$valueBubbleTrack, { left: 0, right: 100, top: 58, bottom: 242, width: 100, height: 184 });
  exposeRect(vertical.instance.$slider, { left: 108, right: 152, top: 50, bottom: 250, width: 44, height: 200 });
  exposeRect(vertical.instance.$valueBubble, { left: 20, right: 90, top: 0, bottom: 30, width: 70, height: 30 });
  vertical.instance.moveCursor(vertical.instance.model.positionCount - 1);
  assert.equal(vertical.instance.$valueBubble.attr('style'), 'top: 7px');
  vertical.instance.moveCursor(0);
  assert.equal(vertical.instance.$valueBubble.attr('style'), 'top: 177px');
});

test('existing content without orientation remains horizontal', () => {
  const params = validParams();
  delete params.orientation;
  const { instance } = createInstance(params);
  attach(instance);
  assert.equal(instance.params.orientation, 'horizontal');
  assert.ok(instance.$scale.classes.has('h5p-scale-question-slider-layout-horizontal'));
  assert.deepEqual(instance.$scale.children.map((child) => child.textValue), ['0', '', '4']);
});

test('vertical orientation places maximum above and minimum below the native range', () => {
  const { instance } = createInstance(validParams({ orientation: 'vertical' }));
  attach(instance);
  assert.equal(instance.params.orientation, 'vertical');
  assert.ok(instance.$scale.classes.has('h5p-scale-question-slider-layout-vertical'));
  assert.equal(instance.$slider.attributes['aria-orientation'], 'vertical');
  assert.equal(instance.$slider.attributes.orient, 'vertical');
  assert.deepEqual(instance.$scale.children.map((child) => child.textValue), ['4', '', '0']);
  assert.match(cssSource, /writing-mode:\s*vertical-lr/);
  assert.match(cssSource, /direction:\s*rtl/);
  assert.match(cssSource, /appearance:\s*slider-vertical/);
});

test('vertical keyboard Up and Down move without selection and Enter confirms', () => {
  const { instance, calls } = createInstance(validParams({ orientation: 'vertical' }));
  attach(instance);
  instance.$slider.triggerEvent('keydown', { key: 'ArrowUp', preventDefault() {} });
  assert.equal(instance.cursorIndex, 1);
  assert.equal(instance.selectedIndex, null);
  assert.equal(instance.attemptsUsed, 0);
  instance.$slider.triggerEvent('keydown', { key: 'ArrowDown', preventDefault() {} });
  assert.equal(instance.cursorIndex, 0);
  assert.equal(instance.selectedIndex, null);
  instance.$slider.triggerEvent('keydown', { key: 'End', preventDefault() {} });
  assert.equal(instance.cursorIndex, 4);
  instance.$slider.triggerEvent('keydown', { key: 'Home', preventDefault() {} });
  assert.equal(instance.cursorIndex, 0);
  instance.$slider.triggerEvent('keydown', { key: 'Enter', preventDefault() {} });
  assert.equal(instance.selectedIndex, 0);
  assert.equal(instance.attemptsUsed, 0);
  assert.equal(xAPIEvents(calls).length, 0);
});

test('vertical pointer and touch releases select their final positions', () => {
  const pointerRuntime = createInstance(validParams({ orientation: 'vertical' }));
  attach(pointerRuntime.instance);
  pointerRuntime.instance.$slider.triggerEvent('pointerdown').val(3).triggerEvent('input');
  assert.equal(pointerRuntime.instance.cursorIndex, 3);
  assert.equal(pointerRuntime.instance.selectedIndex, null);
  pointerRuntime.instance.$slider.triggerEvent('pointerup');
  assert.equal(pointerRuntime.instance.selectedIndex, 3);
  assert.equal(xAPIEvents(pointerRuntime.calls).length, 0);

  const touchRuntime = createInstance(validParams({ orientation: 'vertical' }));
  attach(touchRuntime.instance);
  touchRuntime.instance.$slider.triggerEvent('touchstart').val(2).triggerEvent('input');
  assert.equal(touchRuntime.instance.selectedIndex, null);
  touchRuntime.instance.$slider.triggerEvent('touchend');
  assert.equal(touchRuntime.instance.selectedIndex, 2);
  assert.equal(xAPIEvents(touchRuntime.calls).length, 0);
});

test('vertical negative decimal scale clears stale selection and preserves numerical indexing', () => {
  const { instance, calls } = createInstance(validParams({
    orientation: 'vertical', minimum: -1.5, maximum: 1.5, step: 0.5, correctValue: 0.5
  }));
  attach(instance);
  instance.$slider.val(1).triggerEvent('input').triggerEvent('pointerup');
  assert.equal(instance.selectedIndex, 1);
  assert.equal(instance.formatValue(1), '-1');
  instance.$slider.val(4).triggerEvent('input');
  assert.equal(instance.cursorIndex, 4);
  assert.equal(instance.formatValue(4), '0.5');
  assert.equal(instance.selectedIndex, null);
  assert.equal(calls.buttons['check-answer'].visible, false);
  assert.equal(instance.attemptsUsed, 0);
});

test('vertical automatic checking occurs once per explicit gesture', () => {
  const { instance, calls } = createInstance(validParams({
    orientation: 'vertical', behaviour: { autoCheck: true }
  }));
  attach(instance);
  instance.$slider.val(1).triggerEvent('input');
  assert.equal(instance.attemptsUsed, 0);
  instance.$slider.triggerEvent('pointerup').triggerEvent('mouseup').triggerEvent('click').triggerEvent('change');
  assert.equal(instance.attemptsUsed, 1);
  assert.equal(instance.isCompleted(), false);
  assert.equal(xAPIEvents(calls).length, 0);
  instance.retryTask();
  instance.$slider.triggerEvent('pointerdown').val(2).triggerEvent('input');
  instance.$slider.triggerEvent('pointerup').triggerEvent('mouseup').triggerEvent('click').triggerEvent('change');
  assert.equal(instance.attemptsUsed, 2);
  assert.equal(instance.getScore(), 1);
  assert.equal(xAPIEvents(calls).length, 1);
});

test('saved numerical state restores identically in either orientation', () => {
  const numericalSignature = createInstance(validParams()).instance.model.signature;
  const state = {
    version: 1, cursorIndex: 2, selectedIndex: 2, attemptsUsed: 1, awaitingRetry: false,
    terminal: true, correct: true, solutionVisible: false, numericalSignature
  };
  ['horizontal', 'vertical'].forEach((orientation) => {
    const { instance, calls } = createInstance(validParams({ orientation }), { previousState: state });
    attach(instance);
    assert.deepEqual(plain(instance.getCurrentState()), state);
    assert.equal(instance.$slider.val(), 2);
    assert.equal(instance.getScore(), 1);
    assert.equal(instance.getAnswerGiven(), true);
    assert.equal(instance.$slider.attributes['aria-orientation'], orientation);
    assert.equal(xAPIEvents(calls).length, 0);
  });
});

test('vertical layout leaves optional media registration and scoring unchanged', () => {
  const media = {
    type: {
      library: 'H5P.Image 1.1',
      params: { file: { path: 'images/vertical.png' }, alt: 'Vertical example' }
    }
  };
  const { instance, calls } = createInstance(validParams({ orientation: 'vertical', media }));
  attach(instance);
  assert.deepEqual(calls.registrationOrder, ['media', 'introduction', 'content']);
  instance.$slider.val(2).triggerEvent('input').triggerEvent('pointerup');
  instance.checkAnswer();
  assert.equal(instance.getScore(), 1);
  assert.equal(xAPIEvents(calls).length, 1);
});

test('vertical layout remains in normal flow with and without every supported media type', () => {
  const mediaCases = [
    null,
    {
      type: {
        library: 'H5P.Image 1.1',
        params: { file: { path: 'images/layout.png' }, alt: 'Layout example' }
      }
    },
    {
      type: {
        library: 'H5P.Video 1.6',
        params: { sources: [{ path: 'video/layout.mp4', mime: 'video/mp4' }] }
      }
    },
    {
      type: {
        library: 'H5P.Audio 1.5',
        params: { files: [{ path: 'audio/layout.mp3', mime: 'audio/mpeg' }] }
      }
    }
  ];

  mediaCases.forEach((media) => {
    const { instance, calls } = createInstance(validParams({ orientation: 'vertical', media }));
    attach(instance);
    assert.ok(instance.$scale.classes.has('h5p-scale-question-slider-layout-vertical'));
    assert.deepEqual(instance.$scale.children.map((child) => child.textValue), ['4', '', '0']);
    assert.deepEqual(calls.registrationOrder, media ? ['media', 'introduction', 'content'] : ['introduction', 'content']);
  });
});

test('vertical sizing is independent of iframe height and does not hide H5P.Question controls', () => {
  assert.doesNotMatch(cssSource, /h5p-scale-question-slider-layout-vertical[\s\S]*?\d+(?:\.\d+)?vh/);
  assert.match(cssSource, /height:\s*clamp\(12rem,\s*50vw,\s*20rem\)/);
  assert.doesNotMatch(cssSource, /\.h5p-question-buttons|\.h5p-question-feedback/);
  assert.doesNotMatch(cssSource, /overflow\s*:\s*hidden|position\s*:\s*fixed/);
  assert.match(cssSource, /\.h5p-scale-question-value-bubble\s*\{[\s\S]*?position:\s*absolute/);
  assert.doesNotMatch(cssSource, /\.h5p-scale-question-(?:numerical|slider-layout)\s*\{[^}]*position:\s*absolute/);
});

test('H5P.Question resize events remain observable after image load and feedback', () => {
  const media = {
    type: {
      library: 'H5P.Image 1.1',
      params: { file: { path: 'images/delayed.png' }, alt: 'Delayed image' }
    }
  };
  const { instance, calls } = createInstance(validParams({ orientation: 'vertical', media }));
  let resizeEvents = 0;
  instance.on('resize', () => { resizeEvents++; });
  attach(instance);
  calls.simulateImageLoad();
  assert.equal(resizeEvents, 1);

  instance.selectPosition(1);
  instance.checkAnswer();
  assert.equal(resizeEvents, 2);
  assert.equal(instance.isCompleted(), false);
});

test('horizontal slider keeps its original content-relative layout', () => {
  const { instance } = createInstance();
  attach(instance);
  assert.ok(instance.$scale.classes.has('h5p-scale-question-slider-layout-horizontal'));
  assert.deepEqual(instance.$scale.children.map((child) => child.textValue), ['0', '', '4']);
  assert.equal(instance.$slider.attributes['aria-orientation'], 'horizontal');
});

test('keyboard movement is not selection; Enter explicitly selects', () => {
  const { instance, calls } = createInstance();
  attach(instance);
  instance.$slider.triggerEvent('keydown', { key: 'ArrowRight', preventDefault() {} });
  assert.equal(instance.cursorIndex, 1);
  assert.equal(instance.selectedIndex, null);
  instance.$slider.triggerEvent('keydown', { key: 'Enter', preventDefault() {} });
  assert.equal(instance.selectedIndex, 1);
  assert.equal(instance.getAnswerGiven(), false);
  assert.equal(calls.buttons['check-answer'].visible, true);
  assert.equal(xAPIEvents(calls).length, 0);
});

test('Home and End move without selection; Space explicitly selects', () => {
  const { instance, calls } = createInstance();
  attach(instance);
  instance.$slider.triggerEvent('keydown', { key: 'End', preventDefault() {} });
  assert.equal(instance.cursorIndex, 4);
  assert.equal(instance.selectedIndex, null);
  assert.equal(instance.attemptsUsed, 0);
  instance.$slider.triggerEvent('keydown', { key: 'Home', preventDefault() {} });
  assert.equal(instance.cursorIndex, 0);
  instance.$slider.triggerEvent('keydown', { key: ' ', preventDefault() {} });
  assert.equal(instance.selectedIndex, 0);
  assert.equal(instance.attemptsUsed, 0);
  assert.equal(xAPIEvents(calls).length, 0);
});

test('pointer dragging moves the handle and release explicitly selects', () => {
  const { instance, calls } = createInstance();
  attach(instance);
  instance.$slider.val(3).triggerEvent('input');
  assert.equal(instance.cursorIndex, 3);
  assert.equal(instance.selectedIndex, null);
  instance.$slider.triggerEvent('pointerup');
  assert.equal(instance.selectedIndex, 3);
  assert.equal(xAPIEvents(calls).length, 0);
});

test('touch dragging and release explicitly select without producing xAPI', () => {
  const { instance, calls } = createInstance();
  attach(instance);
  instance.$slider.val(4).triggerEvent('input');
  assert.equal(instance.selectedIndex, null);
  instance.$slider.triggerEvent('touchend');
  assert.equal(instance.selectedIndex, 4);
  assert.equal(xAPIEvents(calls).length, 0);
});

test('track click or tap commits the current snapped position', () => {
  const clickRuntime = createInstance();
  attach(clickRuntime.instance);
  clickRuntime.instance.$slider.val(2.6).triggerEvent('input').triggerEvent('click');
  assert.equal(clickRuntime.instance.cursorIndex, 3);
  assert.equal(clickRuntime.instance.selectedIndex, 3);

  const tapRuntime = createInstance();
  attach(tapRuntime.instance);
  tapRuntime.instance.$slider.val(1).triggerEvent('input').triggerEvent('touchend');
  assert.equal(tapRuntime.instance.selectedIndex, 1);
});

test('negative decimal scales snap by integer index and expose numerical values', () => {
  const { instance } = createInstance(validParams({
    minimum: -1.5, maximum: 1.5, step: 0.5, correctValue: 0.5
  }));
  attach(instance);
  instance.$slider.val(4.7).triggerEvent('input');
  assert.equal(instance.cursorIndex, 5);
  assert.equal(instance.formatValue(instance.cursorIndex), '1');
  assert.equal(instance.$slider.attributes['aria-valuemin'], -1.5);
  assert.equal(instance.$slider.attributes['aria-valuemax'], 1.5);
  assert.equal(instance.$slider.attributes['aria-valuenow'], 1);
  instance.$slider.triggerEvent('pointerup');
  assert.equal(instance.selectedIndex, 5);
});

test('moving away after selection clears the pending answer and Check', () => {
  const { instance, calls } = createInstance();
  attach(instance);
  instance.$slider.val(1).triggerEvent('input').triggerEvent('pointerup');
  assert.equal(instance.selectedIndex, 1);
  assert.equal(calls.buttons['check-answer'].visible, true);
  instance.$slider.val(3).triggerEvent('input');
  assert.equal(instance.cursorIndex, 3);
  assert.equal(instance.selectedIndex, null);
  assert.equal(calls.buttons['check-answer'].visible, false);
  assert.equal(instance.checkAnswer(), false);
  assert.equal(instance.attemptsUsed, 0);
});

test('overlapping pointer, mouse, click, and change events cannot duplicate automatic checks', () => {
  const { instance, calls } = createInstance(validParams({
    behaviour: { autoCheck: true }
  }));
  attach(instance);
  instance.$slider.triggerEvent('pointerdown').val(1).triggerEvent('input');
  instance.$slider.triggerEvent('pointerup').triggerEvent('mouseup').triggerEvent('click').triggerEvent('change');
  assert.equal(instance.attemptsUsed, 1);
  assert.equal(instance.isCompleted(), false);
  assert.equal(xAPIEvents(calls).length, 0);

  instance.retryTask();
  instance.$slider.triggerEvent('pointerdown').val(2).triggerEvent('input');
  instance.$slider.triggerEvent('pointerup').triggerEvent('mouseup').triggerEvent('click').triggerEvent('change');
  assert.equal(instance.attemptsUsed, 2);
  assert.equal(instance.isCompleted(), true);
  assert.equal(xAPIEvents(calls).length, 1);
});

test('slider has keyboard focus and accessible current-versus-selected status', () => {
  const { instance } = createInstance();
  attach(instance);
  instance.$slider.focus();
  assert.equal(instance.$slider.focused, true);
  assert.equal(instance.$slider.attributes['aria-disabled'], 'false');
  assert.match(instance.$slider.attributes['aria-valuetext'], /Cursor at 0/);
  instance.$slider.val(1).triggerEvent('input').triggerEvent('pointerup');
  assert.match(instance.$slider.attributes['aria-valuetext'], /Selected value: 1/);
});

test('custom pointer and touch movement select only on release and clear stale answers', () => {
  const pointerRuntime = createInstance(validCustomParams());
  attach(pointerRuntime.instance);
  pointerRuntime.instance.$slider.triggerEvent('pointerdown').val(1).triggerEvent('input');
  assert.equal(pointerRuntime.instance.cursorIndex, 1);
  assert.equal(pointerRuntime.instance.selectedIndex, null);
  pointerRuntime.instance.$slider.triggerEvent('pointerup');
  assert.equal(pointerRuntime.instance.selectedIndex, 1);
  assert.equal(pointerRuntime.instance.formatValue(pointerRuntime.instance.selectedIndex), 'Cold — Low temperature');
  assert.ok(pointerRuntime.instance.$pointItems[1].classes.has('h5p-scale-question-point-selected'));
  pointerRuntime.instance.$slider.val(3).triggerEvent('input');
  assert.equal(pointerRuntime.instance.selectedIndex, null);
  assert.equal(pointerRuntime.calls.buttons['check-answer'].visible, false);

  const touchRuntime = createInstance(validCustomParams({ orientation: 'vertical' }));
  attach(touchRuntime.instance);
  touchRuntime.instance.$slider.triggerEvent('touchstart').val(2).triggerEvent('input');
  assert.equal(touchRuntime.instance.selectedIndex, null);
  touchRuntime.instance.$slider.triggerEvent('touchend');
  assert.equal(touchRuntime.instance.selectedIndex, 2);
  assert.equal(touchRuntime.instance.formatValue(touchRuntime.instance.selectedIndex), 'Warm — Comfortable');
  assert.equal(xAPIEvents(touchRuntime.calls).length, 0);
});

test('custom keyboard movement announces labels and confirms with Enter or Space', () => {
  const { instance, calls } = createInstance(validCustomParams({ orientation: 'vertical' }));
  attach(instance);
  instance.$slider.triggerEvent('keydown', { key: 'ArrowDown', preventDefault() {} });
  assert.equal(instance.cursorIndex, 1);
  assert.equal(instance.selectedIndex, null);
  assert.match(instance.$slider.attributes['aria-valuetext'], /Cold.*Low temperature/);
  assert.ok(instance.$pointItems[1].classes.has('h5p-scale-question-point-cursor'));
  instance.$slider.triggerEvent('keydown', { key: 'Enter', preventDefault() {} });
  assert.equal(instance.selectedIndex, 1);
  instance.$slider.triggerEvent('keydown', { key: 'ArrowDown', preventDefault() {} });
  assert.equal(instance.selectedIndex, null);
  assert.equal(instance.cursorIndex, 2);
  instance.$slider.triggerEvent('keydown', { key: 'ArrowUp', preventDefault() {} });
  assert.equal(instance.cursorIndex, 1);
  instance.$slider.triggerEvent('keydown', { key: 'End', preventDefault() {} });
  assert.equal(instance.cursorIndex, 3);
  instance.$slider.triggerEvent('keydown', { key: 'Home', preventDefault() {} });
  assert.equal(instance.cursorIndex, 0);
  instance.$slider.triggerEvent('keydown', { key: 'ArrowDown', preventDefault() {} });
  instance.$slider.triggerEvent('keydown', { key: 'ArrowDown', preventDefault() {} });
  instance.$slider.triggerEvent('keydown', { key: ' ', preventDefault() {} });
  assert.equal(instance.selectedIndex, 2);
  assert.equal(instance.attemptsUsed, 0);
  assert.equal(xAPIEvents(calls).length, 0);
});

test('horizontal custom keyboard follows physical order and confirms the authored index once', () => {
  const { instance, calls } = createInstance(validCustomParams());
  attach(instance);
  let prevented = 0;
  const key = (value) => instance.$slider.triggerEvent('keydown', {
    key: value,
    preventDefault() { prevented++; }
  });

  key('ArrowLeft');
  assert.equal(instance.cursorIndex, 1);
  assert.equal(instance.selectedIndex, null);
  assert.match(instance.$slider.attributes['aria-valuetext'], /Cold.*Low temperature/);
  key('Enter');
  assert.equal(instance.selectedIndex, 1);
  key('ArrowLeft');
  assert.equal(instance.cursorIndex, 2);
  assert.equal(instance.selectedIndex, null);
  key('ArrowRight');
  assert.equal(instance.cursorIndex, 1);
  key('Home');
  assert.equal(instance.cursorIndex, 3);
  key('ArrowLeft');
  assert.equal(instance.cursorIndex, 3);
  key('End');
  assert.equal(instance.cursorIndex, 0);
  key('ArrowRight');
  assert.equal(instance.cursorIndex, 0);
  key('ArrowLeft');
  key('ArrowLeft');
  key(' ');
  assert.equal(instance.selectedIndex, 2);
  assert.equal(instance.attemptsUsed, 0);
  assert.equal(xAPIEvents(calls).length, 0);
  assert.equal(prevented, 11);
});

test('custom automatic checking deduplicates overlapping events and emits one terminal xAPI', () => {
  const { instance, calls } = createInstance(validCustomParams({
    behaviour: { autoCheck: true }
  }));
  attach(instance);
  instance.$slider.triggerEvent('pointerdown').val(1).triggerEvent('input');
  instance.$slider.triggerEvent('pointerup').triggerEvent('mouseup').triggerEvent('click').triggerEvent('change');
  assert.equal(instance.attemptsUsed, 1);
  assert.equal(instance.isCompleted(), false);
  assert.equal(xAPIEvents(calls).length, 0);
  instance.retryTask();
  instance.$slider.triggerEvent('pointerdown').val(2).triggerEvent('input');
  instance.$slider.triggerEvent('pointerup').triggerEvent('mouseup').triggerEvent('click').triggerEvent('change');
  assert.equal(instance.attemptsUsed, 2);
  assert.equal(instance.getScore(), 1);
  assert.equal(xAPIEvents(calls).length, 1);
});

test('custom exhausted attempts complete with zero and exactly one answered event', () => {
  const { instance, calls } = createInstance(validCustomParams());
  attach(instance);
  instance.selectPosition(0);
  assert.equal(instance.checkAnswer(), false);
  assert.equal(instance.getAnswerGiven(), false);
  assert.equal(xAPIEvents(calls).length, 0);
  instance.retryTask();
  instance.selectPosition(3);
  assert.equal(instance.checkAnswer(), true);
  assert.equal(instance.getScore(), 0);
  assert.equal(xAPIEvents(calls).length, 1);
  assert.equal(xAPIEvents(calls)[0].data.statement.result.success, false);
});

test('custom state keeps authored indices when orientation changes and rejects changed points', () => {
  const original = createInstance(validCustomParams());
  attach(original.instance);
  original.instance.selectPosition(1);
  original.instance.checkAnswer();
  const state = plain(original.instance.getCurrentState());
  assert.equal(state.customPointSignature, original.instance.model.signature);

  const restored = createInstance(validCustomParams({ orientation: 'vertical' }), { previousState: state });
  attach(restored.instance);
  assert.equal(restored.instance.cursorIndex, 1);
  assert.equal(restored.instance.selectedIndex, 1);
  assert.equal(restored.instance.attemptsUsed, 1);
  assert.equal(restored.instance.getAnswerGiven(), false);
  assert.equal(restored.instance.$slider.attributes['aria-orientation'], 'vertical');
  assert.equal(restored.instance.$pointList.children[1].attributes['data-index'], 1);
  assert.equal(xAPIEvents(restored.calls).length, 0);

  const restoredHorizontal = createInstance(validCustomParams(), { previousState: state });
  attach(restoredHorizontal.instance);
  assert.equal(restoredHorizontal.instance.cursorIndex, 1);
  assert.equal(restoredHorizontal.instance.selectedIndex, 1);
  assert.equal(restoredHorizontal.instance.$pointList.children[2].attributes['data-index'], 1);
  assert.equal(restoredHorizontal.instance.formatValue(1), 'Cold — Low temperature');
  assert.equal(xAPIEvents(restoredHorizontal.calls).length, 0);

  const reorderedPoints = customPoints();
  reorderedPoints.reverse();
  const changed = createInstance(validCustomParams({ customPoints: reorderedPoints }), { previousState: state });
  attach(changed.instance);
  assert.equal(changed.instance.cursorIndex, 0);
  assert.equal(changed.instance.selectedIndex, null);
  assert.equal(changed.instance.attemptsUsed, 0);
  assert.equal(changed.instance.getAnswerGiven(), false);
});

test('completed custom state restores score without replaying answered xAPI', () => {
  const completed = createInstance(validCustomParams());
  attach(completed.instance);
  completed.instance.selectPosition(2);
  completed.instance.checkAnswer();
  const state = plain(completed.instance.getCurrentState());

  const restored = createInstance(validCustomParams(), { previousState: state });
  attach(restored.instance);
  assert.equal(restored.instance.getAnswerGiven(), true);
  assert.equal(restored.instance.getScore(), 1);
  assert.equal(restored.instance.selectedIndex, 2);
  assert.equal(restored.instance.$slider.prop('disabled'), true);
  assert.equal(xAPIEvents(restored.calls).length, 0);
});

test('correct flag follows its custom point when the author reorders the list', () => {
  const points = customPoints();
  const correctPoint = points.splice(2, 1)[0];
  points.unshift(correctPoint);
  const { instance } = createInstance(validCustomParams({ customPoints: points }));
  attach(instance);
  assert.equal(instance.model.correctIndex, 0);
  assert.equal(instance.formatValue(0), 'Warm — Comfortable');
  instance.selectPosition(0);
  instance.checkAnswer();
  assert.equal(instance.getScore(), 1);
});

test('middle custom answer keeps its score and xAPI identity in both orientations', () => {
  ['horizontal', 'vertical'].forEach((orientation) => {
    const { instance, calls } = createInstance(validCustomParams({ orientation }));
    attach(instance);
    instance.selectPosition(2);
    instance.checkAnswer();
    assert.equal(instance.getScore(), 1);
    assert.equal(instance.model.correctIndex, 2);
    assert.equal(instance.formatValue(2), 'Warm — Comfortable');
    assert.equal(xAPIEvents(calls).length, 1);
    assert.equal(xAPIEvents(calls)[0].data.statement.result.response, 'point-2');
    assert.deepEqual(
      plain(xAPIEvents(calls)[0].data.statement.object.definition.correctResponsesPattern),
      ['point-2']
    );
  });
});

test('custom Show Solution uses the correct physical point and Reset clears state', () => {
  ['horizontal', 'vertical'].forEach((orientation) => {
    const { instance, calls } = createInstance(validCustomParams({ orientation }));
    attach(instance);
    instance.selectPosition(1);
    instance.showSolutions();
    assert.equal(instance.cursorIndex, 1);
    assert.equal(instance.$slider.val(), 1);
    assert.equal(instance.selectedIndex, 1);
    assert.ok(instance.$pointItems[2].classes.has('h5p-scale-question-point-solution'));
    assert.equal(instance.$pointItems[2].classes.has('h5p-scale-question-feedback-correct'), false);
    const visiblePosition = orientation === 'horizontal' ? 1 : 2;
    assert.equal(instance.$pointList.children[visiblePosition].attributes['data-index'], 2);
    assert.equal(instance.$pointList.children[visiblePosition].children[0].textValue, 'Warm');
    assert.equal(instance.getScore(), 0);
    assert.equal(xAPIEvents(calls).length, 0);
    instance.resetTask();
    assert.equal(instance.cursorIndex, 0);
    assert.equal(instance.selectedIndex, null);
    assert.equal(instance.solutionVisible, false);
    assert.equal(xAPIEvents(calls).length, 0);
  });
});

test('selection remains neutral until Check and Retry restores neutral styling in both orientations', () => {
  ['horizontal', 'vertical'].forEach((orientation) => {
    [validParams({ orientation }), validCustomParams({ orientation })].forEach((params) => {
      const { instance } = createInstance(params);
      attach(instance);
      instance.selectPosition(1);

      assert.ok(instance.$valueStatus.classes.has('h5p-scale-question-value-status-selected'));
      assert.equal(instance.$valueStatus.classes.has('h5p-scale-question-feedback-correct'), false);
      assert.equal(instance.$valueStatus.classes.has('h5p-scale-question-feedback-incorrect'), false);
      assert.equal(instance.$slider.classes.has('h5p-scale-question-feedback-correct'), false);
      assert.equal(instance.$slider.classes.has('h5p-scale-question-feedback-incorrect'), false);

      if (instance.model.mode === 'numerical') {
        assert.ok(instance.$valueBubble.classes.has('h5p-scale-question-value-bubble-selected'));
        assert.equal(instance.$valueBubble.classes.has('h5p-scale-question-feedback-correct'), false);
        assert.equal(instance.$valueBubble.classes.has('h5p-scale-question-feedback-incorrect'), false);
      }
      else {
        assert.ok(instance.$pointItems[1].classes.has('h5p-scale-question-point-selected'));
        assert.equal(instance.$pointItems[1].classes.has('h5p-scale-question-feedback-correct'), false);
        assert.equal(instance.$pointItems[1].classes.has('h5p-scale-question-feedback-incorrect'), false);
      }

      instance.checkAnswer();
      assert.ok(instance.$valueStatus.classes.has('h5p-scale-question-feedback-incorrect'));
      if (instance.model.mode === 'numerical') {
        assert.ok(instance.$valueBubble.classes.has('h5p-scale-question-feedback-incorrect'));
      }
      else {
        assert.ok(instance.$pointItems[1].classes.has('h5p-scale-question-feedback-incorrect'));
      }

      instance.retryTask();
      assert.equal(instance.$valueStatus.classes.has('h5p-scale-question-value-status-selected'), false);
      assert.equal(instance.$valueStatus.classes.has('h5p-scale-question-feedback-correct'), false);
      assert.equal(instance.$valueStatus.classes.has('h5p-scale-question-feedback-incorrect'), false);
      if (instance.model.mode === 'numerical') {
        assert.equal(instance.$valueBubble.classes.has('h5p-scale-question-value-bubble-selected'), false);
        assert.equal(instance.$valueBubble.classes.has('h5p-scale-question-feedback-incorrect'), false);
      }
      else {
        assert.equal(instance.$pointItems[1].classes.has('h5p-scale-question-point-selected'), false);
        assert.equal(instance.$pointItems[1].classes.has('h5p-scale-question-feedback-incorrect'), false);
      }
    });
  });
});

test('checked correct selections receive feedback styling without colouring the slider', () => {
  ['horizontal', 'vertical'].forEach((orientation) => {
    [validParams({ orientation }), validCustomParams({ orientation })].forEach((params) => {
      const { instance } = createInstance(params);
      attach(instance);
      instance.selectPosition(2);
      instance.checkAnswer();

      assert.ok(instance.$valueStatus.classes.has('h5p-scale-question-feedback-correct'));
      assert.ok(instance.$valueStatusIcon.classes.has('h5p-scale-question-feedback-icon-correct'));
      assert.equal(instance.$solutionStatus.text(), '');
      assert.equal(instance.$slider.classes.has('h5p-scale-question-feedback-correct'), false);
      if (instance.model.mode === 'numerical') {
        assert.ok(instance.$valueBubble.classes.has('h5p-scale-question-feedback-correct'));
      }
      else {
        assert.ok(instance.$pointItems[2].classes.has('h5p-scale-question-feedback-correct'));
      }
    });
  });

  assert.match(cssSource, /H5PFontAwesome4/);
  assert.match(cssSource, /content:\s*'\\f00c'/);
  assert.match(cssSource, /content:\s*'\\f00d'/);
  assert.doesNotMatch(cssSource, /slider\.h5p-scale-question-(?:selected|correct)[^{]*\{[^}]*accent-color/);
});

test('theme variables control ordinary, neutral, and evaluated colours without theme-specific overrides', () => {
  const themed = {
    '--h5p-theme-text-primary': '#e1e2e3',
    '--h5p-theme-alternative-light': '#212223',
    '--h5p-theme-alternative-darker': '#a1a2a3',
    '--h5p-theme-contrast-cta-white': '#88bbff',
    '--h5p-theme-feedback-correct-main': '#11aa11',
    '--h5p-theme-feedback-correct-secondary': '#113311',
    '--h5p-theme-feedback-correct-third': '#55cc55',
    '--h5p-theme-feedback-incorrect-main': '#ff8888',
    '--h5p-theme-feedback-incorrect-secondary': '#441111',
    '--h5p-theme-feedback-incorrect-third': '#dd5555'
  };

  const question = cssDeclarationsFor('.h5p-scale-question-numerical');
  const bound = cssDeclarationsFor('.h5p-scale-question-bound');
  const pointLabels = cssDeclarationsFor('.h5p-scale-question-points');
  const valueBubble = cssDeclarationsFor('.h5p-scale-question-value-bubble');
  const selectedPoint = cssDeclarationsFor('.h5p-scale-question-point-selected');
  const selectedValue = cssDeclarationsFor('.h5p-scale-question-value-status-selected');
  const pointCursor = cssDeclarationsFor('.h5p-scale-question-point-cursor');
  const sliderFocus = cssDeclarationsFor('.h5p-scale-question-slider:focus-visible');
  const pointSolution = cssDeclarationsFor('.h5p-scale-question-point-solution');
  const bubbleSolution = cssDeclarationsFor('.h5p-scale-question-value-bubble-solution');
  const correct = cssDeclarationsFor('.h5p-scale-question-feedback-correct');
  const incorrect = cssDeclarationsFor('.h5p-scale-question-feedback-incorrect');

  assert.equal(resolveThemeValue(question.color, themed), themed['--h5p-theme-text-primary']);
  assert.equal(resolveThemeValue(bound.color, themed), themed['--h5p-theme-text-primary']);
  assert.equal(resolveThemeValue(pointLabels.color, themed), themed['--h5p-theme-text-primary']);
  [valueBubble, selectedPoint, selectedValue].forEach((declarations) => {
    assert.equal(resolveThemeValue(declarations.color, themed), themed['--h5p-theme-text-primary']);
    assert.equal(resolveThemeValue(declarations['background-color'], themed), themed['--h5p-theme-alternative-light']);
    const border = declarations['border-color'] || declarations.border;
    assert.match(resolveThemeValue(border, themed), new RegExp(themed['--h5p-theme-alternative-darker']));
  });
  assert.match(resolveThemeValue(pointCursor.outline, themed), new RegExp(themed['--h5p-theme-contrast-cta-white']));
  assert.match(resolveThemeValue(sliderFocus.outline, themed), new RegExp(themed['--h5p-theme-contrast-cta-white']));
  assert.equal(resolveThemeValue(correct.color, themed), themed['--h5p-theme-feedback-correct-main']);
  assert.equal(resolveThemeValue(correct['background-color'], themed), themed['--h5p-theme-feedback-correct-secondary']);
  assert.match(resolveThemeValue(correct.border, themed), new RegExp(themed['--h5p-theme-feedback-correct-third']));
  assert.equal(resolveThemeValue(incorrect.color, themed), themed['--h5p-theme-feedback-incorrect-main']);
  assert.equal(resolveThemeValue(incorrect['background-color'], themed), themed['--h5p-theme-feedback-incorrect-secondary']);
  assert.match(resolveThemeValue(incorrect.border, themed), new RegExp(themed['--h5p-theme-feedback-incorrect-third']));
  assert.equal(resolveThemeValue(pointSolution['border-color'], themed), themed['--h5p-theme-feedback-correct-third']);
  assert.equal(resolveThemeValue(pointSolution.color, themed), themed['--h5p-theme-feedback-correct-main']);
  assert.equal(resolveThemeValue(pointSolution['background-color'], themed),
    themed['--h5p-theme-feedback-correct-secondary']);
  assert.match(resolveThemeValue(pointSolution.outline, themed), new RegExp(themed['--h5p-theme-feedback-correct-main']));
  assert.equal(resolveThemeValue(bubbleSolution.color, themed), themed['--h5p-theme-feedback-correct-main']);
  assert.equal(resolveThemeValue(bubbleSolution['background-color'], themed), themed['--h5p-theme-feedback-correct-secondary']);

  assert.equal(resolveThemeValue(selectedPoint.color), '#27313d');
  assert.equal(resolveThemeValue(selectedPoint['background-color']), '#f5f6f7');
  assert.equal(resolveThemeValue(selectedPoint['border-color']), '#697585');
  assert.doesNotMatch(cssSource, /(?:dark|mint|lavender|sunset)[^,{]*\{/i);
  assert.match(cssSource, /content:\s*'\\f00c'/);
  assert.match(cssSource, /content:\s*'\\f00d'/);
  assert.doesNotMatch(cssSource,
    /h5p-scale-question-solution-status[^,{]*::(?:before|after)/);
});

test('custom vertical media layout retains resize behavior and no iframe-height sizing', () => {
  const media = {
    type: {
      library: 'H5P.Image 1.1',
      params: { file: { path: 'images/custom.png' }, alt: 'Custom scale reference' }
    }
  };
  const { instance, calls } = createInstance(validCustomParams({ orientation: 'vertical', media }));
  let resizeEvents = 0;
  instance.on('resize', () => { resizeEvents++; });
  attach(instance);
  assert.deepEqual(calls.registrationOrder, ['media', 'introduction', 'content']);
  calls.simulateImageLoad();
  assert.equal(resizeEvents, 1);
  assert.doesNotMatch(cssSource, /h5p-scale-question-custom-frame-vertical[\s\S]*?\d+(?:\.\d+)?vh/);
});

test('numerical answers below and above compose directional and one-remaining feedback in both orientations', () => {
  ['horizontal', 'vertical'].forEach((orientation) => {
    const feedback = {
      feedbackBelowCorrect: 'Too low! Try a higher value.',
      feedbackAboveCorrect: 'Too high! Try a lower value.'
    };

    const below = createInstance(validParams({ orientation, ...feedback }));
    attach(below.instance);
    below.instance.selectPosition(1);
    assert.equal(below.instance.checkAnswer(), false);
    assert.equal(
      below.calls.feedback.at(-1)[0],
      combinedIncorrectFeedback(feedback.feedbackBelowCorrect, 1)
    );
    assert.equal(below.instance.attemptsUsed, 1);
    assert.equal(below.instance.getAnswerGiven(), false);
    assert.equal(xAPIEvents(below.calls).length, 0);

    const above = createInstance(validParams({ orientation, ...feedback }));
    attach(above.instance);
    above.instance.selectPosition(3);
    assert.equal(above.instance.checkAnswer(), false);
    assert.equal(
      above.calls.feedback.at(-1)[0],
      combinedIncorrectFeedback(feedback.feedbackAboveCorrect, 1)
    );
    assert.equal(above.instance.attemptsUsed, 1);
    assert.equal(above.instance.getAnswerGiven(), false);
    assert.equal(xAPIEvents(above.calls).length, 0);

    const correct = createInstance(validParams({ orientation, ...feedback }));
    attach(correct.instance);
    correct.instance.selectPosition(2);
    assert.equal(correct.instance.checkAnswer(), true);
    assert.equal(correct.calls.feedback.at(-1)[0], 'Correct.');
    assert.equal(correct.instance.getScore(), 1);
    assert.equal(xAPIEvents(correct.calls).length, 1);
  });
});

test('custom-point answers below and above compose directional and one-remaining feedback in both orientations', () => {
  ['horizontal', 'vertical'].forEach((orientation) => {
    const feedback = {
      feedbackBelowCorrect: 'Too early! Try a later date.',
      feedbackAboveCorrect: 'Too late! Try an earlier date.'
    };

    const below = createInstance(validCustomParams({ orientation, ...feedback }));
    attach(below.instance);
    below.instance.selectPosition(3);
    assert.equal(below.instance.checkAnswer(), false);
    assert.equal(
      below.calls.feedback.at(-1)[0],
      combinedIncorrectFeedback(feedback.feedbackBelowCorrect, 1)
    );
    assert.equal(below.instance.selectedIndex, 3);
    assert.equal(xAPIEvents(below.calls).length, 0);

    const above = createInstance(validCustomParams({ orientation, ...feedback }));
    attach(above.instance);
    above.instance.selectPosition(1);
    assert.equal(above.instance.checkAnswer(), false);
    assert.equal(
      above.calls.feedback.at(-1)[0],
      combinedIncorrectFeedback(feedback.feedbackAboveCorrect, 1)
    );
    assert.equal(above.instance.selectedIndex, 1);
    assert.equal(xAPIEvents(above.calls).length, 0);

    const correct = createInstance(validCustomParams({ orientation, ...feedback }));
    attach(correct.instance);
    correct.instance.selectPosition(2);
    assert.equal(correct.instance.checkAnswer(), true);
    assert.equal(correct.calls.feedback.at(-1)[0], 'Correct.');
    assert.equal(correct.instance.getScore(), 1);
    assert.equal(xAPIEvents(correct.calls).length, 1);
  });
});

test('missing, one-sided, and empty directional messages use the configured message or generic fallback', () => {
  const cases = [
    { params: {}, selectedIndex: 1, expected: /1 attempt/ },
    {
      params: { feedbackBelowCorrect: 'Move higher.' },
      selectedIndex: 1,
      expected: combinedIncorrectFeedback('Move higher.', 1)
    },
    { params: { feedbackBelowCorrect: 'Move higher.' }, selectedIndex: 3, expected: /1 attempt/ },
    {
      params: { feedbackAboveCorrect: 'Move lower.' },
      selectedIndex: 3,
      expected: combinedIncorrectFeedback('Move lower.', 1)
    },
    { params: { feedbackAboveCorrect: 'Move lower.' }, selectedIndex: 1, expected: /1 attempt/ },
    {
      params: { feedbackBelowCorrect: '   ', feedbackAboveCorrect: '' },
      selectedIndex: 1,
      expected: /1 attempt/
    }
  ];

  cases.forEach(({ params, selectedIndex, expected }) => {
    const { instance, calls } = createInstance(validParams(params));
    attach(instance);
    instance.selectPosition(selectedIndex);
    assert.equal(instance.checkAnswer(), false);
    if (expected instanceof RegExp) {
      assert.match(calls.feedback.at(-1)[0], expected);
    }
    else {
      assert.equal(calls.feedback.at(-1)[0], expected);
    }
    assert.equal(instance.attemptsUsed, 1);
    assert.equal(xAPIEvents(calls).length, 0);
  });
});

test('directional feedback pluralizes multiple remaining attempts', () => {
  const { instance, calls } = createInstance(validParams({
    maxAttempts: 3,
    feedbackBelowCorrect: 'Move higher.'
  }));
  attach(instance);
  instance.selectPosition(1);
  assert.equal(instance.checkAnswer(), false);
  assert.equal(
    calls.feedback.at(-1)[0],
    combinedIncorrectFeedback('Move higher.', 2)
  );
  assert.match(
    cssSource,
    /\.h5p-scale-question-feedback-parts\s*\{[^}]*display:\s*grid;[^}]*gap:\s*0\.35rem;/
  );
  assert.match(
    cssSource,
    /\.h5p-scale-question-attempt-feedback\s*\{[^}]*font-weight:\s*600;/
  );
});

test('final incorrect attempt keeps terminal feedback instead of directional retry guidance', () => {
  const directional = 'Too low! Try a higher value.';
  const { instance, calls } = createInstance(validParams({
    maxAttempts: 1,
    feedbackBelowCorrect: directional
  }));
  attach(instance);
  instance.selectPosition(1);
  assert.equal(instance.checkAnswer(), true);
  assert.equal(instance.isCompleted(), true);
  assert.equal(instance.getScore(), 0);
  assert.equal(calls.feedback.at(-1)[0], 'Incorrect. 0 attempts remaining.');
  assert.notEqual(calls.feedback.at(-1)[0], directional);
  assert.equal(xAPIEvents(calls).length, 1);
});

test('automatic checking uses directional feedback only after explicit selection', () => {
  const { instance, calls } = createInstance(validParams({
    feedbackBelowCorrect: 'Move higher.',
    feedbackAboveCorrect: 'Move lower.',
    behaviour: { autoCheck: true }
  }));
  attach(instance);
  instance.moveCursor(1);
  assert.equal(instance.attemptsUsed, 0);
  assert.equal(calls.feedback.length, 0);
  assert.equal(xAPIEvents(calls).length, 0);

  instance.selectPosition(1);
  assert.equal(instance.attemptsUsed, 1);
  assert.equal(calls.feedback.at(-1)[0], combinedIncorrectFeedback('Move higher.', 1));
  assert.equal(instance.getAnswerGiven(), false);
  assert.equal(xAPIEvents(calls).length, 0);

  instance.retryTask();
  instance.selectPosition(2);
  assert.equal(instance.getAnswerGiven(), true);
  assert.equal(instance.getScore(), 1);
  assert.equal(calls.feedback.at(-1)[0], 'Correct.');
  assert.equal(xAPIEvents(calls).length, 1);
});

test('tolerance scoring accepts boundaries and interior positions and reports an xAPI numeric range', () => {
  const params = validParams({
    minimum: 4000,
    maximum: 5000,
    step: 10,
    correctValue: 4806,
    acceptedTolerance: 100
  });

  [71, 80, 90].forEach((index) => {
    const { instance, calls } = createInstance(params);
    attach(instance);
    instance.selectPosition(index);
    assert.equal(instance.checkAnswer(), true);
    assert.equal(instance.getScore(), 1);
    assert.equal(instance.getMaxScore(), 1);
    assert.equal(xAPIEvents(calls).length, 1);
    const statement = xAPIEvents(calls)[0].data.statement;
    assert.deepEqual(plain(statement.object.definition.correctResponsesPattern), ['4710[:]4900']);
    assert.equal(statement.result.response, instance.formatValue(index));
    assert.equal(statement.result.success, true);
  });

  [70, 91].forEach((index) => {
    const { instance, calls } = createInstance(validParams({ ...params, maxAttempts: 1 }));
    attach(instance);
    instance.selectPosition(index);
    assert.equal(instance.checkAnswer(), true);
    assert.equal(instance.getScore(), 0);
    assert.equal(xAPIEvents(calls)[0].data.statement.result.success, false);
  });
});

test('tolerance directional feedback uses interval bounds in both orientations', () => {
  ['horizontal', 'vertical'].forEach((orientation) => {
    const params = validParams({
      orientation,
      minimum: 0,
      maximum: 10,
      step: 1,
      correctValue: 5,
      acceptedTolerance: 2,
      feedbackBelowCorrect: 'Below interval.',
      feedbackAboveCorrect: 'Above interval.'
    });

    const below = createInstance(params);
    attach(below.instance);
    below.instance.selectPosition(2);
    assert.equal(below.instance.checkAnswer(), false);
    assert.equal(
      below.calls.feedback.at(-1)[0],
      combinedIncorrectFeedback('Below interval.', 1)
    );

    const above = createInstance(params);
    attach(above.instance);
    above.instance.selectPosition(8);
    assert.equal(above.instance.checkAnswer(), false);
    assert.equal(
      above.calls.feedback.at(-1)[0],
      combinedIncorrectFeedback('Above interval.', 1)
    );

    const inside = createInstance(params);
    attach(inside.instance);
    inside.instance.selectPosition(3);
    assert.equal(inside.instance.checkAnswer(), true);
    assert.equal(
      inside.calls.feedback.at(-1)[0],
      'Correct. Your answer is within the accepted tolerance of ±2.'
    );
    assert.equal(inside.instance.getScore(), 1);
  });

  const terminal = createInstance(validParams({
    minimum: 0,
    maximum: 10,
    step: 1,
    correctValue: 5,
    acceptedTolerance: 2,
    maxAttempts: 1,
    feedbackBelowCorrect: 'Below interval.'
  }));
  attach(terminal.instance);
  terminal.instance.selectPosition(2);
  terminal.instance.checkAnswer();
  assert.equal(terminal.calls.feedback.at(-1)[0], 'Incorrect. 0 attempts remaining.');
});

test('automatic checking awards tolerance only after explicit selection', () => {
  const { instance, calls } = createInstance(validParams({
    minimum: 0,
    maximum: 10,
    step: 2,
    correctValue: 5,
    acceptedTolerance: 1,
    behaviour: { autoCheck: true }
  }));
  attach(instance);
  instance.moveCursor(2);
  assert.equal(instance.valueAt(2), 4);
  assert.equal(instance.attemptsUsed, 0);
  assert.equal(xAPIEvents(calls).length, 0);
  instance.selectPosition(2);
  assert.equal(instance.attemptsUsed, 1);
  assert.equal(instance.getScore(), 1);
  assert.equal(instance.getAnswerGiven(), true);
  assert.equal(xAPIEvents(calls).length, 1);
});

test('accepted approximate answer appends its tolerance explanation to correct feedback', () => {
  const { instance, calls } = createInstance(validParams({
    minimum: 4000,
    maximum: 5000,
    step: 10,
    correctValue: 4800,
    acceptedTolerance: 100,
    l10n: { correctFeedback: 'Well done!' }
  }));
  attach(instance);
  instance.selectPosition(79);
  assert.equal(instance.checkAnswer(), true);
  assert.equal(
    calls.feedback.at(-1)[0],
    'Well done! Your answer is within the accepted tolerance of ±100.'
  );
});

test('exact correct answer preserves correct feedback when tolerance is positive', () => {
  const { instance, calls } = createInstance(validParams({
    correctValue: 2,
    acceptedTolerance: 1,
    l10n: { correctFeedback: '  Exactly right!  ' }
  }));
  attach(instance);
  instance.selectPosition(2);
  instance.checkAnswer();
  assert.equal(calls.feedback.at(-1)[0], '  Exactly right!  ');
});

test('non-selectable correct answer makes every accepted selectable answer approximate', () => {
  [2, 3].forEach((selectedIndex) => {
    const { instance, calls } = createInstance(validParams({
      minimum: 0,
      maximum: 10,
      step: 2,
      correctValue: 5,
      acceptedTolerance: 1,
      l10n: { correctFeedback: 'Correct.' }
    }));
    attach(instance);
    instance.selectPosition(selectedIndex);
    instance.checkAnswer();
    assert.equal(
      calls.feedback.at(-1)[0],
      'Correct. Your answer is within the accepted tolerance of ±1.'
    );
  });
});

test('approximate explanation stands alone when correct feedback is empty', () => {
  const { instance, calls } = createInstance(validParams({
    correctValue: 2,
    acceptedTolerance: 1,
    l10n: { correctFeedback: '' }
  }));
  attach(instance);
  instance.selectPosition(1);
  instance.checkAnswer();
  assert.equal(calls.feedback.at(-1)[0], 'Your answer is within the accepted tolerance of ±1.');
});

test('approximate explanation uses existing decimal numerical formatting', () => {
  const { instance, calls } = createInstance(validParams({
    minimum: 0,
    maximum: 1,
    step: 0.1,
    correctValue: 0.5,
    acceptedTolerance: 0.25,
    l10n: { correctFeedback: 'Accepted' }
  }));
  attach(instance);
  instance.selectPosition(4);
  instance.checkAnswer();
  assert.equal(
    calls.feedback.at(-1)[0],
    'Accepted. Your answer is within the accepted tolerance of ±0.25.'
  );
});

test('incorrect and zero-tolerance answers do not add an approximate explanation', () => {
  const incorrect = createInstance(validParams({
    correctValue: 2,
    acceptedTolerance: 1,
    feedbackBelowCorrect: 'Move higher.'
  }));
  attach(incorrect.instance);
  incorrect.instance.selectPosition(0);
  assert.equal(incorrect.instance.checkAnswer(), false);
  assert.equal(
    incorrect.calls.feedback.at(-1)[0],
    combinedIncorrectFeedback('Move higher.', 1)
  );

  const exact = createInstance(validParams({
    acceptedTolerance: 0,
    l10n: { correctFeedback: 'Unchanged.' }
  }));
  attach(exact.instance);
  exact.instance.selectPosition(2);
  exact.instance.checkAnswer();
  assert.equal(exact.calls.feedback.at(-1)[0], 'Unchanged.');
});

test('custom-point correct feedback remains unchanged', () => {
  const { instance, calls } = createInstance(validCustomParams({
    l10n: { correctFeedback: 'Custom correct.' }
  }));
  attach(instance);
  instance.selectPosition(2);
  instance.checkAnswer();
  assert.equal(calls.feedback.at(-1)[0], 'Custom correct.');
});

test('Check and automatic-check modes show identical approximate feedback after selection', () => {
  const feedbackByMode = [false, true].map((autoCheck) => {
    const { instance, calls } = createInstance(validParams({
      correctValue: 2,
      acceptedTolerance: 1,
      behaviour: { autoCheck },
      l10n: { correctFeedback: 'Correct.' }
    }));
    attach(instance);
    instance.moveCursor(1);
    assert.equal(calls.feedback.length, 0);
    instance.selectPosition(1);
    if (!autoCheck) {
      assert.equal(calls.feedback.length, 0);
      instance.checkAnswer();
    }
    return calls.feedback.at(-1)[0];
  });

  assert.deepEqual(feedbackByMode, [
    'Correct. Your answer is within the accepted tolerance of ±1.',
    'Correct. Your answer is within the accepted tolerance of ±1.'
  ]);
});

test('tolerance Show Solution labels an accepted position without moving the submitted answer', () => {
  ['horizontal', 'vertical'].forEach((orientation) => {
    const { instance, calls } = createInstance(validParams({
      orientation,
      minimum: 0,
      maximum: 10,
      step: 2,
      correctValue: 4.5,
      acceptedTolerance: 1.5
    }));
    attach(instance);
    instance.selectPosition(0);
    instance.showSolutions();
    assert.equal(instance.solutionVisible, true);
    assert.equal(instance.cursorIndex, 0);
    assert.equal(instance.valueAt(instance.model.solutionIndex), 4);
    assert.equal(instance.isCorrectIndex(instance.model.solutionIndex), true);
    assert.equal(instance.selectedIndex, 0);
    assert.equal(instance.attemptsUsed, 0);
    assert.equal(instance.getAnswerGiven(), false);
    assert.equal(instance.getScore(), 0);
    assert.equal(instance.$slider.prop('disabled'), true);
    assert.equal(instance.$slider.val(), 0);
    assert.equal(instance.$slider.attributes['aria-valuetext'], 'Selected value: 0. Correct answer: 4');
    assert.equal(instance.$valueStatus.text(), 'Selected value: 0');
    assert.equal(instance.$solutionStatus.text(), 'Correct answer: 4');
    assert.equal(xAPIEvents(calls).length, 0);
  });
});

test('numerical signature preserves orientation changes and rejects changed answer criteria', () => {
  const params = validParams({
    minimum: 0,
    maximum: 10,
    step: 2,
    correctValue: 5,
    acceptedTolerance: 1
  });
  const original = createInstance(params);
  attach(original.instance);
  original.instance.selectPosition(2);
  original.instance.checkAnswer();
  const state = plain(original.instance.getCurrentState());
  assert.equal(state.numericalSignature, original.instance.model.signature);

  const restored = createInstance({ ...params, orientation: 'vertical' }, { previousState: state });
  attach(restored.instance);
  assert.equal(restored.instance.selectedIndex, 2);
  assert.equal(restored.instance.getScore(), 1);
  assert.equal(restored.instance.getAnswerGiven(), true);
  assert.equal(xAPIEvents(restored.calls).length, 0);

  const unsignedState = { ...state };
  delete unsignedState.numericalSignature;
  const unsigned = createInstance(params, { previousState: unsignedState });
  attach(unsigned.instance);
  assert.equal(unsigned.instance.cursorIndex, 0);
  assert.equal(unsigned.instance.selectedIndex, null);
  assert.equal(unsigned.instance.getAnswerGiven(), false);
  assert.equal(xAPIEvents(unsigned.calls).length, 0);

  [
    { ...params, correctValue: 7 },
    { ...params, acceptedTolerance: 2 }
  ].forEach((changedParams) => {
    const changed = createInstance(changedParams, { previousState: state });
    attach(changed.instance);
    assert.equal(changed.instance.cursorIndex, 0);
    assert.equal(changed.instance.selectedIndex, null);
    assert.equal(changed.instance.attemptsUsed, 0);
    assert.equal(changed.instance.getAnswerGiven(), false);
    assert.equal(xAPIEvents(changed.calls).length, 0);
  });
});

test('intermediate incorrect check allows another attempt and emits no action xAPI', () => {
  const { instance, calls } = createInstance();
  attach(instance);
  instance.selectPosition(1);
  assert.equal(instance.checkAnswer(), false);
  assert.equal(instance.attemptsUsed, 1);
  assert.equal(instance.isCompleted(), false);
  assert.equal(instance.getAnswerGiven(), false);
  assert.equal(instance.getScore(), 0);
  assert.equal(xAPIEvents(calls).length, 0);
  assert.match(calls.feedback.at(-1)[0], /1 attempt/);
});

test('one attempt with Retry disabled preserves terminal single-attempt behavior', () => {
  const { instance, calls } = createInstance(validParams({
    maxAttempts: 1,
    behaviour: { enableRetry: false }
  }));
  attach(instance);
  instance.selectPosition(1);

  assert.equal(instance.checkAnswer(), true);
  assert.equal(instance.attemptsUsed, 1);
  assert.equal(instance.awaitingRetry, false);
  assert.equal(instance.terminal, true);
  assert.equal(instance.getScore(), 0);
  assert.equal(calls.feedback.at(-1)[0], 'Incorrect. 0 attempts remaining.');
  assert.equal(calls.buttons['check-answer'].visible, false);
  assert.equal(calls.buttons['try-again'].visible, false);
  assert.equal(calls.buttons['show-solution'].visible, true);
  assert.equal(instance.$slider.prop('disabled'), true);
  assert.equal(xAPIEvents(calls).length, 1);
});

test('Retry disabled makes a correct first answer terminal without rewriting maxAttempts', () => {
  const params = validParams({
    maxAttempts: 4,
    behaviour: { enableRetry: false }
  });
  const { instance, calls } = createInstance(params);
  attach(instance);
  instance.selectPosition(2);

  assert.equal(instance.checkAnswer(), true);
  assert.equal(instance.params.maxAttempts, 4);
  assert.equal(instance.params.behaviour.enableRetry, false);
  assert.equal(instance.attemptsUsed, 1);
  assert.equal(instance.awaitingRetry, false);
  assert.equal(instance.terminal, true);
  assert.equal(instance.getScore(), 1);
  assert.equal(calls.feedback.at(-1)[0], 'Correct.');
  assert.equal(calls.buttons['check-answer'].visible, false);
  assert.equal(calls.buttons['try-again'].visible, false);
  assert.equal(calls.buttons['show-solution'].visible, false);
  assert.equal(instance.$slider.prop('disabled'), true);
  assert.equal(xAPIEvents(calls).length, 1);
});

test('Retry disabled makes an incorrect first answer terminal with terminal feedback and solution', () => {
  const { instance, calls } = createInstance(validParams({
    maxAttempts: 4,
    feedbackBelowCorrect: 'Move higher.',
    behaviour: { enableRetry: false }
  }));
  attach(instance);
  instance.selectPosition(1);

  assert.equal(instance.checkAnswer(), true);
  assert.equal(instance.attemptsUsed, 1);
  assert.equal(instance.awaitingRetry, false);
  assert.equal(instance.terminal, true);
  assert.equal(instance.getScore(), 0);
  assert.equal(calls.feedback.at(-1)[0], 'Incorrect. 0 attempts remaining.');
  assert.doesNotMatch(calls.feedback.at(-1)[0], /remaining attempt|Move higher/);
  assert.equal(calls.buttons['check-answer'].visible, false);
  assert.equal(calls.buttons['try-again'].visible, false);
  assert.equal(calls.buttons['show-solution'].visible, true);
  assert.equal(instance.$slider.prop('disabled'), true);

  instance.checkAnswer();
  instance.retryTask();
  assert.equal(instance.attemptsUsed, 1);
  assert.equal(instance.terminal, true);
  assert.equal(xAPIEvents(calls).length, 1);
});

test('Retry-disabled terminal state restores without replaying xAPI or exposing Retry', () => {
  const params = validParams({
    maxAttempts: 3,
    behaviour: { enableRetry: false }
  });
  const original = createInstance(params);
  attach(original.instance);
  original.instance.selectPosition(1);
  original.instance.checkAnswer();
  const state = plain(original.instance.getCurrentState());

  assert.equal(state.awaitingRetry, false);
  assert.equal(state.terminal, true);
  assert.equal(state.attemptsUsed, 1);

  const restored = createInstance(params, { previousState: state });
  attach(restored.instance);
  assert.equal(restored.instance.params.maxAttempts, 3);
  assert.equal(restored.instance.params.behaviour.enableRetry, false);
  assert.equal(restored.instance.attemptsUsed, 1);
  assert.equal(restored.instance.awaitingRetry, false);
  assert.equal(restored.instance.terminal, true);
  assert.equal(restored.instance.getScore(), 0);
  assert.equal(restored.instance.$slider.prop('disabled'), true);
  assert.equal(restored.calls.buttons['check-answer'].visible, false);
  assert.equal(restored.calls.buttons['try-again'].visible, false);
  assert.equal(restored.calls.buttons['show-solution'].visible, true);
  assert.equal(xAPIEvents(restored.calls).length, 0);
});

test('legacy awaiting-Retry state becomes a safe terminal result when Retry is disabled', () => {
  const params = validParams({
    maxAttempts: 3,
    behaviour: { enableRetry: false }
  });
  const numericalSignature = createInstance(params).instance.model.signature;
  const legacyState = {
    version: 1,
    cursorIndex: 1,
    selectedIndex: 1,
    attemptsUsed: 1,
    awaitingRetry: true,
    terminal: false,
    correct: false,
    solutionVisible: false,
    numericalSignature
  };
  const { instance, calls } = createInstance(params, { previousState: legacyState });
  attach(instance);

  assert.equal(instance.attemptsUsed, 1);
  assert.equal(instance.awaitingRetry, false);
  assert.equal(instance.terminal, true);
  assert.equal(instance.getScore(), 0);
  assert.equal(instance.$slider.prop('disabled'), true);
  assert.equal(calls.buttons['check-answer'].visible, false);
  assert.equal(calls.buttons['try-again'].visible, false);
  assert.equal(calls.buttons['show-solution'].visible, true);
  assert.equal(xAPIEvents(calls).length, 0);
});

test('Retry-disabled terminal completion fully resets without changing authored settings', () => {
  const params = validParams({
    maxAttempts: 5,
    behaviour: { enableRetry: false }
  });
  const { instance, calls } = createInstance(params);
  attach(instance);
  instance.selectPosition(1);
  instance.checkAnswer();
  instance.resetTask();

  assert.equal(instance.params.maxAttempts, 5);
  assert.equal(instance.params.behaviour.enableRetry, false);
  assert.equal(instance.attemptsUsed, 0);
  assert.equal(instance.awaitingRetry, false);
  assert.equal(instance.terminal, false);
  assert.equal(instance.selectedIndex, null);
  assert.equal(instance.cursorIndex, 0);
  assert.equal(instance.getAnswerGiven(), false);
  assert.equal(instance.$slider.prop('disabled'), false);
  assert.equal(calls.buttons['check-answer'].visible, false);
  assert.equal(calls.buttons['try-again'].visible, false);
  assert.equal(calls.buttons['show-solution'].visible, false);
  assert.equal(xAPIEvents(calls).length, 1);
});

test('incorrect Check locks interaction until Retry and Retry preserves the attempt budget', () => {
  const { instance, calls } = createInstance();
  attach(instance);
  instance.selectPosition(1);

  assert.equal(instance.checkAnswer(), false);
  assert.equal(instance.attemptsUsed, 1);
  assert.equal(instance.awaitingRetry, true);
  assert.equal(calls.feedback.at(-1)[0], 'Incorrect. 1 attempt remaining.');
  assert.equal(calls.buttons['check-answer'].visible, false);
  assert.equal(calls.buttons['try-again'].visible, true);
  assert.equal(calls.buttons['show-solution'].visible, false);
  assert.equal(instance.$slider.prop('disabled'), true);

  instance.moveCursor(3);
  instance.selectPosition(3);
  instance.checkAnswer();
  assert.equal(instance.cursorIndex, 1);
  assert.equal(instance.selectedIndex, 1);
  assert.equal(instance.attemptsUsed, 1);
  assert.equal(xAPIEvents(calls).length, 0);

  calls.buttons['try-again'].callback();
  assert.equal(instance.attemptsUsed, 1);
  assert.equal(instance.awaitingRetry, false);
  assert.equal(instance.cursorIndex, 0);
  assert.equal(instance.selectedIndex, null);
  assert.equal(instance.$slider.prop('disabled'), false);
  assert.equal(calls.buttons['try-again'].visible, false);
  assert.equal(calls.buttons['check-answer'].visible, false);
  assert.equal(calls.feedbackRemoved, 1);
  assert.equal(xAPIEvents(calls).length, 0);
});

test('two incorrect attempts require one Retry and cannot be extended by repeated Retry', () => {
  const { instance, calls } = createInstance();
  attach(instance);
  instance.selectPosition(0);
  instance.checkAnswer();
  calls.buttons['try-again'].callback();
  calls.buttons['try-again'].callback();
  assert.equal(instance.attemptsUsed, 1);

  instance.selectPosition(1);
  assert.equal(instance.checkAnswer(), true);
  assert.equal(instance.attemptsUsed, 2);
  assert.equal(instance.terminal, true);
  assert.equal(instance.awaitingRetry, false);
  assert.equal(calls.feedback.at(-1)[0], 'Incorrect. 0 attempts remaining.');
  assert.equal(calls.buttons['check-answer'].visible, false);
  assert.equal(calls.buttons['try-again'].visible, false);
  assert.equal(calls.buttons['show-solution'].visible, true);
  assert.equal(xAPIEvents(calls).length, 1);

  calls.buttons['try-again'].callback();
  assert.equal(instance.attemptsUsed, 2);
  assert.equal(instance.terminal, true);
  assert.equal(xAPIEvents(calls).length, 1);
});

test('correct second attempt is terminal and full Reset restores a fresh allowance and xAPI guard', () => {
  const { instance, calls } = createInstance();
  attach(instance);
  instance.selectPosition(0);
  instance.checkAnswer();
  instance.retryTask();
  instance.selectPosition(2);
  instance.checkAnswer();

  assert.equal(instance.attemptsUsed, 2);
  assert.equal(instance.getScore(), 1);
  assert.equal(calls.buttons['try-again'].visible, false);
  assert.equal(calls.buttons['show-solution'].visible, false);
  assert.equal(xAPIEvents(calls).length, 1);

  instance.resetTask();
  assert.equal(instance.attemptsUsed, 0);
  assert.equal(instance.awaitingRetry, false);
  assert.equal(instance.selectedIndex, null);
  assert.equal(instance.cursorIndex, 0);
  assert.equal(instance.getAnswerGiven(), false);
  instance.selectPosition(2);
  instance.checkAnswer();
  assert.equal(instance.attemptsUsed, 1);
  assert.equal(xAPIEvents(calls).length, 2);
});

test('saved state awaiting Retry restores directional and remaining feedback, lock, and buttons', () => {
  const params = validParams({ feedbackBelowCorrect: 'Move higher.' });
  const original = createInstance(params);
  attach(original.instance);
  original.instance.selectPosition(1);
  original.instance.checkAnswer();
  const state = plain(original.instance.getCurrentState());
  assert.equal(state.awaitingRetry, true);

  const restored = createInstance(params, { previousState: state });
  attach(restored.instance);
  assert.equal(restored.instance.attemptsUsed, 1);
  assert.equal(restored.instance.awaitingRetry, true);
  assert.equal(restored.instance.selectedIndex, 1);
  assert.equal(restored.instance.$slider.prop('disabled'), true);
  assert.equal(restored.calls.buttons['check-answer'].visible, false);
  assert.equal(restored.calls.buttons['try-again'].visible, true);
  assert.equal(restored.calls.buttons['show-solution'].visible, false);
  assert.equal(
    restored.calls.feedback.at(-1)[0],
    combinedIncorrectFeedback('Move higher.', 1)
  );
  assert.equal(xAPIEvents(restored.calls).length, 0);

  restored.instance.retryTask();
  restored.instance.selectPosition(2);
  restored.instance.checkAnswer();
  assert.equal(restored.instance.attemptsUsed, 2);
  assert.equal(restored.instance.getScore(), 1);
  assert.equal(xAPIEvents(restored.calls).length, 1);
});

test('automatic numerical and custom-point modes also require Retry between attempts', () => {
  [
    validParams({ behaviour: { autoCheck: true } }),
    validCustomParams({ behaviour: { autoCheck: true } })
  ].forEach((params) => {
    const { instance, calls } = createInstance(params);
    attach(instance);
    instance.selectPosition(1);
    assert.equal(instance.attemptsUsed, 1);
    assert.equal(instance.awaitingRetry, true);
    assert.equal(calls.buttons['try-again'].visible, true);
    assert.equal(xAPIEvents(calls).length, 0);

    instance.selectPosition(2);
    assert.equal(instance.attemptsUsed, 1);
    instance.retryTask();
    instance.selectPosition(2);
    assert.equal(instance.attemptsUsed, 2);
    assert.equal(instance.getScore(), 1);
    assert.equal(calls.buttons['try-again'].visible, false);
    assert.equal(xAPIEvents(calls).length, 1);
  });
});

test('correct answer completes with score 1 and exactly one answered event', () => {
  const { instance, calls } = createInstance();
  attach(instance);
  instance.selectPosition(2);
  assert.equal(instance.checkAnswer(), true);
  assert.equal(instance.isCompleted(), true);
  assert.equal(instance.isPassed(), true);
  assert.equal(instance.getAnswerGiven(), true);
  assert.equal(instance.getScore(), 1);
  assert.equal(xAPIEvents(calls).length, 1);
  const event = xAPIEvents(calls)[0];
  assert.equal(event.getVerb(), 'answered');
  assert.deepEqual(plain(event.data.statement.result.score), { min: 0, max: 1, raw: 1, scaled: 1 });
  assert.equal(event.data.statement.result.completion, true);
  assert.equal(event.data.statement.result.success, true);
  assert.equal(event.data.statement.result.response, '2');
  assert.deepEqual(plain(event.data.statement.object.definition.correctResponsesPattern), ['2']);
  assert.equal(event.data.statement.object.definition.interactionType, 'numeric');
  instance.checkAnswer();
  assert.equal(xAPIEvents(calls).length, 1);
});

test('exhausting attempts completes incorrectly with score 0', () => {
  const { instance, calls } = createInstance();
  attach(instance);
  instance.selectPosition(0);
  instance.checkAnswer();
  instance.retryTask();
  instance.selectPosition(1);
  assert.equal(instance.checkAnswer(), true);
  assert.equal(instance.isCompleted(), true);
  assert.equal(instance.isPassed(), false);
  assert.equal(instance.getScore(), 0);
  assert.equal(xAPIEvents(calls).length, 1);
  assert.equal(xAPIEvents(calls)[0].data.statement.result.success, false);
});

test('Show Solution stays hidden until an enabled question reaches terminal incorrect state', () => {
  ['horizontal', 'vertical'].forEach((orientation) => {
    const { instance, calls } = createInstance(validParams({ orientation }));
    attach(instance);
    assert.equal(calls.buttons['show-solution'].visible, false);

    instance.selectPosition(0);
    assert.equal(calls.buttons['show-solution'].visible, false);
    assert.equal(instance.checkAnswer(), false);
    assert.equal(instance.attemptsUsed, 1);
    assert.equal(calls.buttons['show-solution'].visible, false);

    instance.retryTask();
    instance.selectPosition(1);
    assert.equal(instance.checkAnswer(), true);
    assert.equal(instance.terminal, true);
    assert.equal(instance.correct, false);
    assert.equal(instance.attemptsUsed, 2);
    assert.equal(calls.buttons['show-solution'].visible, true);
  });
});

test('correct terminal answers never expose Show Solution', () => {
  const firstAttempt = createInstance();
  attach(firstAttempt.instance);
  firstAttempt.instance.selectPosition(2);
  firstAttempt.instance.checkAnswer();
  assert.equal(firstAttempt.instance.correct, true);
  assert.equal(firstAttempt.calls.buttons['show-solution'].visible, false);

  const laterAttempt = createInstance();
  attach(laterAttempt.instance);
  laterAttempt.instance.selectPosition(0);
  laterAttempt.instance.checkAnswer();
  laterAttempt.instance.retryTask();
  laterAttempt.instance.selectPosition(2);
  laterAttempt.instance.checkAnswer();
  assert.equal(laterAttempt.instance.correct, true);
  assert.equal(laterAttempt.instance.attemptsUsed, 2);
  assert.equal(laterAttempt.calls.buttons['show-solution'].visible, false);
});

test('Show Solution respects author disabling and a one-attempt limit', () => {
  const disabled = createInstance(validParams({
    maxAttempts: 1,
    behaviour: { enableSolutionsButton: false }
  }));
  attach(disabled.instance);
  disabled.instance.selectPosition(0);
  disabled.instance.checkAnswer();
  assert.equal(disabled.instance.terminal, true);
  assert.equal(disabled.calls.buttons['show-solution'].visible, false);

  const enabled = createInstance(validParams({ maxAttempts: 1 }));
  attach(enabled.instance);
  enabled.instance.selectPosition(0);
  enabled.instance.checkAnswer();
  assert.equal(enabled.instance.terminal, true);
  assert.equal(enabled.instance.attemptsUsed, 1);
  assert.equal(enabled.calls.buttons['show-solution'].visible, true);
});

test('automatic Check and custom-point modes use the same terminal visibility rule', () => {
  [
    validParams({ behaviour: { autoCheck: true } }),
    validCustomParams({ behaviour: { autoCheck: true } }),
    validCustomParams({ orientation: 'vertical', behaviour: { autoCheck: true } })
  ].forEach((params) => {
    const { instance, calls } = createInstance(params);
    attach(instance);
    const wrongIndices = instance.model.mode === 'customPoints' ? [0, 1] : [0, 1];
    instance.selectPosition(wrongIndices[0]);
    assert.equal(instance.terminal, false);
    assert.equal(calls.buttons['show-solution'].visible, false);
    instance.retryTask();
    instance.selectPosition(wrongIndices[1]);
    assert.equal(instance.terminal, true);
    assert.equal(instance.correct, false);
    assert.equal(calls.buttons['show-solution'].visible, true);
  });
});

test('terminal outcomes hide child-local Retry and full Reset hides Show Solution', () => {
  const { instance, calls } = createInstance(validParams({ maxAttempts: 1 }));
  attach(instance);
  instance.selectPosition(0);
  instance.checkAnswer();
  assert.equal(calls.buttons['show-solution'].visible, true);
  assert.equal(calls.buttons['try-again'].visible, false);
  calls.buttons['try-again'].callback();
  assert.equal(instance.terminal, true);
  assert.equal(instance.attemptsUsed, 1);
  assert.equal(calls.buttons['show-solution'].visible, true);
  instance.resetTask();
  assert.equal(instance.terminal, false);
  assert.equal(instance.attemptsUsed, 0);
  assert.equal(calls.buttons['show-solution'].visible, false);
});

test('restored state derives Show Solution visibility from terminal result and exhausted attempts', () => {
  const params = validParams({ maxAttempts: 2 });
  const numericalSignature = createInstance(params).instance.model.signature;
  const states = [
    {
      state: { version: 1, cursorIndex: 1, selectedIndex: 1, attemptsUsed: 2,
        terminal: true, correct: false, solutionVisible: false, numericalSignature },
      visible: true
    },
    {
      state: { version: 1, cursorIndex: 2, selectedIndex: 2, attemptsUsed: 2,
        terminal: true, correct: true, solutionVisible: false, numericalSignature },
      visible: false
    },
    {
      state: { version: 1, cursorIndex: 1, selectedIndex: 1, attemptsUsed: 1,
        terminal: false, correct: false, solutionVisible: false, numericalSignature },
      visible: false
    },
    {
      state: { version: 1, cursorIndex: 1, selectedIndex: 1, attemptsUsed: 1,
        terminal: true, correct: false, solutionVisible: false, numericalSignature },
      visible: false
    }
  ];

  states.forEach(({ state, visible }) => {
    const { instance, calls } = createInstance(params, { previousState: state });
    attach(instance);
    assert.equal(calls.buttons['show-solution'].visible, visible);
  });
});

test('terminal numerical Show Solution renders ordered selected and solution rows in both orientations', () => {
  ['horizontal', 'vertical'].forEach((orientation) => {
    const { instance, calls } = createInstance(validParams({ orientation, maxAttempts: 1 }));
    attach(instance);
    instance.selectPosition(1);
    instance.checkAnswer();
    const eventCount = xAPIEvents(calls).length;
    instance.showSolutions();

    assert.equal(instance.$statusGroup.children[0], instance.$valueStatus);
    assert.equal(instance.$statusGroup.children[1], instance.$solutionStatus);
    assert.equal(instance.$valueStatus.text(), 'Selected value: 1');
    assert.equal(instance.$solutionStatus.text(), 'Correct answer: 2');
    assert.ok(instance.$valueStatus.classes.has('h5p-scale-question-feedback-incorrect'));
    assert.ok(instance.$valueStatusIcon.classes.has('h5p-scale-question-feedback-icon-incorrect'));
    assert.equal(instance.$valueStatusIcon.attributes['aria-hidden'], 'true');
    assert.ok(instance.$solutionStatus.classes.has('h5p-scale-question-feedback-correct'));
    assert.equal(instance.$solutionStatus.children.length, 1);
    assert.equal(instance.$slider.val(), 1);
    assert.equal(instance.cursorIndex, 1);
    assert.equal(instance.selectedIndex, 1);
    assert.equal(instance.$valueBubble.text(), '2');
    assert.ok(instance.$valueBubble.classes.has('h5p-scale-question-value-bubble-solution'));
    assert.equal(instance.$valueBubble.classes.has('h5p-scale-question-feedback-correct'), false);
    assert.equal(instance.$valueBubble.classes.has('h5p-scale-question-feedback-incorrect'), false);
    assert.equal(instance.getScore(), 0);
    assert.equal(xAPIEvents(calls).length, eventCount);
  });
});

test('terminal custom-point Show Solution separates long labels and scale indicators in both orientations', () => {
  ['horizontal', 'vertical'].forEach((orientation) => {
    const points = customPoints();
    points[2] = {
      value: 'A deliberately long correct value',
      label: 'A long explanatory label that must wrap in a narrow container',
      correct: true
    };
    const { instance, calls } = createInstance(validCustomParams({
      orientation,
      customPoints: points,
      maxAttempts: 1
    }));
    attach(instance);
    instance.selectPosition(1);
    instance.checkAnswer();
    const eventCount = xAPIEvents(calls).length;
    instance.showSolutions();

    assert.equal(instance.$valueStatus.text(), 'Selected value: Cold — Low temperature');
    assert.equal(
      instance.$solutionStatus.text(),
      'Correct answer: A deliberately long correct value — ' +
        'A long explanatory label that must wrap in a narrow container'
    );
    assert.ok(instance.$pointItems[1].classes.has('h5p-scale-question-feedback-incorrect'));
    assert.ok(instance.$pointItems[2].classes.has('h5p-scale-question-point-solution'));
    assert.equal(instance.$pointItems[2].classes.has('h5p-scale-question-feedback-correct'), false);
    assert.equal(instance.$pointItems[2].classes.has('h5p-scale-question-feedback-incorrect'), false);
    assert.equal(instance.$slider.val(), 1);
    assert.equal(instance.cursorIndex, 1);
    assert.equal(instance.selectedIndex, 1);
    assert.equal(instance.getScore(), 0);
    assert.equal(xAPIEvents(calls).length, eventCount);
  });

  assert.match(cssSource, /\.h5p-scale-question-value-status\s*\{[^}]*overflow-wrap:\s*anywhere/);
  assert.match(cssSource, /\.h5p-scale-question-custom-viewport\s*\{[^}]*overflow-x:\s*auto/);
});

test('Retry-disabled terminal Show Solution uses the same two-row display', () => {
  const { instance, calls } = createInstance(validParams({
    maxAttempts: 4,
    behaviour: { enableRetry: false }
  }));
  attach(instance);
  instance.selectPosition(1);
  instance.checkAnswer();
  assert.equal(instance.terminal, true);
  assert.equal(instance.attemptsUsed, 1);
  assert.equal(calls.buttons['show-solution'].visible, true);

  calls.buttons['show-solution'].callback();
  assert.equal(instance.$valueStatus.text(), 'Selected value: 1');
  assert.equal(instance.$solutionStatus.text(), 'Correct answer: 2');
  assert.equal(instance.awaitingRetry, false);
  assert.equal(instance.attemptsUsed, 1);
  assert.equal(xAPIEvents(calls).length, 1);
});

test('exhausted attempts retain the submitted answer when revealing the solution', () => {
  const { instance, calls } = createInstance();
  attach(instance);
  instance.selectPosition(0);
  instance.checkAnswer();
  instance.retryTask();
  instance.selectPosition(1);
  instance.checkAnswer();
  const event = plain(xAPIEvents(calls)[0].data.statement);

  instance.showSolutions();
  assert.equal(instance.selectedIndex, 1);
  assert.equal(instance.cursorIndex, 1);
  assert.equal(instance.attemptsUsed, 2);
  assert.equal(instance.getScore(), 0);
  assert.equal(instance.$valueStatus.text(), 'Selected value: 1');
  assert.equal(instance.$solutionStatus.text(), 'Correct answer: 2');
  assert.deepEqual(plain(xAPIEvents(calls)[0].data.statement), event);
  assert.equal(xAPIEvents(calls).length, 1);
});

test('saved Show Solution state restores two rows and normalizes an old moved cursor', () => {
  const params = validParams({ maxAttempts: 1 });
  const original = createInstance(params);
  attach(original.instance);
  original.instance.selectPosition(1);
  original.instance.checkAnswer();
  original.instance.showSolutions();
  const state = plain(original.instance.getCurrentState());
  state.cursorIndex = original.instance.model.solutionIndex;

  const restored = createInstance(params, { previousState: state });
  attach(restored.instance);
  assert.equal(restored.instance.solutionVisible, true);
  assert.equal(restored.instance.selectedIndex, 1);
  assert.equal(restored.instance.cursorIndex, 1);
  assert.equal(restored.instance.$slider.val(), 1);
  assert.equal(restored.instance.$valueStatus.text(), 'Selected value: 1');
  assert.equal(restored.instance.$solutionStatus.text(), 'Correct answer: 2');
  assert.equal(restored.instance.$slider.attributes['aria-valuetext'],
    'Selected value: 1. Correct answer: 2');
  assert.equal(xAPIEvents(restored.calls).length, 0);
});

test('Reset removes solution rows and solution-specific scale styling', () => {
  const { instance } = createInstance(validCustomParams({ maxAttempts: 1 }));
  attach(instance);
  instance.selectPosition(1);
  instance.checkAnswer();
  instance.showSolutions();
  instance.resetTask();

  assert.equal(instance.solutionVisible, false);
  assert.equal(instance.$solutionStatus.text(), '');
  assert.ok(instance.$solutionStatus.classes.has('h5p-scale-question-value-status-empty'));
  assert.equal(instance.$solutionStatus.classes.has('h5p-scale-question-feedback-correct'), false);
  assert.equal(instance.$pointItems[2].classes.has('h5p-scale-question-point-solution'), false);
  assert.equal(instance.$valueStatusIcon.classes.has('h5p-scale-question-feedback-icon-incorrect'), false);
  assert.equal(instance.$slider.prop('disabled'), false);
});

test('Show Solution click preserves final answer, result, attempts, feedback, and xAPI', () => {
  const { instance, calls } = createInstance(validParams({
    maxAttempts: 1,
    minimum: 0,
    maximum: 10,
    step: 2,
    correctValue: 5,
    acceptedTolerance: 1
  }));
  attach(instance);
  instance.selectPosition(0);
  instance.checkAnswer();
  const recordedAnswer = instance.selectedIndex;
  const attempts = instance.attemptsUsed;
  const feedback = calls.feedback.at(-1)[0];
  const eventCount = xAPIEvents(calls).length;
  assert.equal(calls.buttons['show-solution'].visible, true);

  calls.buttons['show-solution'].callback();
  assert.equal(instance.solutionVisible, true);
  assert.equal(instance.selectedIndex, recordedAnswer);
  assert.equal(instance.attemptsUsed, attempts);
  assert.equal(instance.getScore(), 0);
  assert.equal(instance.getAnswerGiven(), true);
  assert.equal(calls.feedback.at(-1)[0], feedback);
  assert.equal(xAPIEvents(calls).length, eventCount);
  assert.equal(instance.$valueStatus.text(), 'Selected value: 0');
  assert.equal(instance.$solutionStatus.text(), 'Correct answer: 6');
  assert.equal(calls.buttons['show-solution'].visible, false);
});

test('unfinished state restores without completion or events', () => {
  const numericalSignature = createInstance(validParams()).instance.model.signature;
  const state = {
    version: 1, cursorIndex: 3, selectedIndex: 1, attemptsUsed: 1, awaitingRetry: false,
    terminal: false, correct: false, solutionVisible: false, numericalSignature
  };
  const { instance, calls } = createInstance(validParams(), { previousState: state });
  attach(instance);
  assert.deepEqual(plain(instance.getCurrentState()), state);
  assert.equal(instance.$slider.val(), 3);
  assert.equal(instance.$slider.attributes['aria-valuenow'], 3);
  assert.equal(instance.$slider.prop('disabled'), false);
  assert.equal(instance.getAnswerGiven(), false);
  assert.equal(xAPIEvents(calls).length, 0);
});

test('completed state restores its score without replaying answered', () => {
  const numericalSignature = createInstance(validParams()).instance.model.signature;
  const state = {
    version: 1, cursorIndex: 2, selectedIndex: 2, attemptsUsed: 1,
    terminal: true, correct: true, solutionVisible: false, numericalSignature
  };
  const { instance, calls } = createInstance(validParams(), { previousState: state });
  attach(instance);
  assert.equal(instance.getAnswerGiven(), true);
  assert.equal(instance.getScore(), 1);
  assert.equal(instance.$slider.val(), 2);
  assert.equal(instance.$slider.prop('disabled'), true);
  assert.equal(xAPIEvents(calls).length, 0);
  instance.$slider.val(4).triggerEvent('input').triggerEvent('pointerup');
  assert.equal(instance.cursorIndex, 2);
  assert.equal(instance.selectedIndex, 2);
  assert.equal(instance.$slider.val(), 2);
  instance.checkAnswer();
  assert.equal(xAPIEvents(calls).length, 0);
});

test('Show Solution and Reset are non-completing and event-free', () => {
  const { instance, calls } = createInstance();
  attach(instance);
  instance.selectPosition(1);
  instance.showSolutions();
  assert.equal(instance.solutionVisible, true);
  assert.equal(instance.cursorIndex, 1);
  assert.equal(instance.selectedIndex, 1);
  assert.equal(instance.$slider.val(), 1);
  assert.equal(instance.$slider.prop('disabled'), true);
  assert.equal(instance.$slider.attributes['aria-valuetext'], 'Selected value: 1. Correct answer: 2');
  assert.equal(instance.getAnswerGiven(), false);
  assert.equal(xAPIEvents(calls).length, 0);
  instance.resetTask();
  assert.deepEqual(plain(instance.getCurrentState()), {
    version: 1, cursorIndex: 0, selectedIndex: null, attemptsUsed: 0, awaitingRetry: false,
    terminal: false, correct: false, solutionVisible: false,
    numericalSignature: instance.model.signature
  });
  assert.equal(instance.$slider.val(), 0);
  assert.equal(instance.$slider.prop('disabled'), false);
  assert.equal(xAPIEvents(calls).length, 0);
});

test('autoCheck checks only explicit selection', () => {
  const { instance, calls } = createInstance(validParams({
    behaviour: { autoCheck: true }
  }));
  attach(instance);
  instance.moveCursor(1);
  assert.equal(instance.attemptsUsed, 0);
  assert.equal(xAPIEvents(calls).length, 0);
  instance.selectPosition(1);
  assert.equal(instance.attemptsUsed, 1);
  assert.equal(instance.isCompleted(), false);
  instance.retryTask();
  instance.selectPosition(2);
  assert.equal(instance.isCompleted(), true);
  assert.equal(instance.getScore(), 1);
  assert.equal(xAPIEvents(calls).length, 1);
  assert.equal(calls.buttons['check-answer'].visible, false);
});

test('QuestionSet-facing contract changes answer state only at terminal', () => {
  const { instance, calls } = createInstance();
  attach(instance);
  let terminalNotifications = 0;
  instance.on('xAPI', (event) => {
    if (event.getVerb() === 'answered' && instance.getAnswerGiven()) terminalNotifications++;
  });
  instance.selectPosition(1);
  instance.checkAnswer();
  assert.equal(instance.getAnswerGiven(), false);
  assert.equal(terminalNotifications, 0);
  instance.retryTask();
  instance.selectPosition(2);
  instance.checkAnswer();
  assert.equal(instance.getAnswerGiven(), true);
  assert.equal(terminalNotifications, 1);
  assert.equal(xAPIEvents(calls).length, 1);
});

test('Column-facing contract exposes task identity and only terminal scored completion', () => {
  const { instance } = createInstance();
  attach(instance);
  let completedTasks = 0;
  instance.on('xAPI', (event) => {
    if (event.getScore() !== null) completedTasks++;
  });
  assert.equal(instance.isTask, true);
  instance.selectPosition(0);
  instance.checkAnswer();
  assert.equal(completedTasks, 0);
  instance.retryTask();
  instance.selectPosition(1);
  instance.checkAnswer();
  assert.equal(completedTasks, 1);
});

test('InteractiveBook-facing contract cannot complete on selection or intermediate check', () => {
  const { instance } = createInstance();
  attach(instance);
  let taskDone = false;
  instance.on('xAPI', (event) => {
    if (['answered', 'completed', 'interacted', 'attempted'].includes(event.getVerb())) {
      taskDone = instance.getAnswerGiven();
    }
  });
  instance.selectPosition(0);
  assert.equal(taskDone, false);
  instance.checkAnswer();
  assert.equal(taskDone, false);
  instance.retryTask();
  instance.selectPosition(1);
  instance.checkAnswer();
  assert.equal(taskDone, true);
});

test('getXAPIData returns valid reporting data without emitting an event', () => {
  const { instance, calls } = createInstance();
  attach(instance);
  instance.selectPosition(2);
  const data = instance.getXAPIData();
  assert.equal(data.statement.result.response, '2');
  assert.equal(data.statement.result.completion, false);
  assert.equal(data.statement.object.definition.interactionType, 'numeric');
  assert.equal(data.statement.object.definition.description.en, 'Choose two');
  assert.equal(xAPIEvents(calls).length, 0);
});

test('getTitle uses metadata and falls back to the display title', () => {
  assert.equal(createInstance(validParams(), { metadata: { title: 'Number line' } }).instance.getTitle(), 'Number line');
  assert.equal(createInstance().instance.getTitle(), 'Scale Question');
});

test('runtime localization semantics expose the current feedback templates', () => {
  const l10n = semantics.find((field) => field.name === 'l10n');
  const byName = Object.fromEntries(l10n.fields.map((field) => [field.name, field]));

  assert.equal(byName.incorrectFeedback, undefined);
  assert.equal(byName.incorrectFeedbackSingular.default, 'Incorrect. @remaining attempt remaining.');
  assert.equal(byName.incorrectFeedbackPlural.default, 'Incorrect. @remaining attempts remaining.');
  assert.equal(byName.terminalIncorrectFeedback.default, 'Incorrect. 0 attempts remaining.');
  const singularIndex = l10n.fields.findIndex((field) => field.name === 'incorrectFeedbackSingular');
  assert.deepEqual(
    l10n.fields.slice(singularIndex, singularIndex + 3).map((field) => field.name),
    ['incorrectFeedbackSingular', 'incorrectFeedbackPlural', 'terminalIncorrectFeedback']
  );
  assert.equal(
    byName.acceptedToleranceFeedback.default,
    'Your answer is within the accepted tolerance of ±@tolerance.'
  );
  assert.equal(byName.defaultTitle.default, 'Scale Question');
  assert.equal(
    byName.acceptedRange.default,
    'Accepted interval: @lower to @upper. Slider shows accepted position @value.'
  );

  [
    'configurationErrorPrefix', 'maxAttemptsError', 'customPointsCountError',
    'customPointValueRequiredError', 'customPointValueLengthError',
    'customPointLabelTypeError', 'customPointLabelLengthError',
    'customPointCorrectCountError', 'minimumFiniteError', 'maximumFiniteError',
    'stepFiniteError', 'correctValueFiniteError', 'acceptedToleranceFiniteError',
    'minimumMaximumError', 'stepPositiveError', 'toleranceNonNegativeError',
    'correctValueRangeError', 'safeIntegerError', 'correctValueReachableError',
    'acceptedIntervalError'
  ].forEach((name) => assert.equal(typeof byName[name].default, 'string', name));
});

test('common localization semantics contain no hidden none widget', () => {
  const l10n = semantics.find((field) => field.name === 'l10n');
  assert.equal(l10n.common, true);
  assert.equal(l10n.fields.some((field) => field.widget === 'none'), false);
  assert.equal(l10n.fields.some((field) => field.name === 'incorrectFeedback'), false);
});

test('every configuration validation path uses its localized message', () => {
  const { H5P } = createRuntime();
  const cases = [
    ['maxAttemptsError', validParams({ maxAttempts: 0 })],
    ['customPointsCountError', validCustomParams({ customPoints: [{ value: 'Only', correct: true }] })],
    ['customPointValueRequiredError', validCustomParams({ customPoints: [
      { value: '', correct: true }, { value: 'B', correct: false }
    ] })],
    ['customPointValueLengthError', validCustomParams({ customPoints: [
      { value: 'x'.repeat(41), correct: true }, { value: 'B', correct: false }
    ] })],
    ['customPointLabelTypeError', validCustomParams({ customPoints: [
      { value: 'A', label: 1, correct: true }, { value: 'B', correct: false }
    ] })],
    ['customPointLabelLengthError', validCustomParams({ customPoints: [
      { value: 'A', label: 'x'.repeat(81), correct: true }, { value: 'B', correct: false }
    ] })],
    ['customPointCorrectCountError', validCustomParams({ customPoints: [
      { value: 'A', correct: false }, { value: 'B', correct: false }
    ] })],
    ['minimumFiniteError', validParams({ minimum: Infinity })],
    ['maximumFiniteError', validParams({ maximum: Infinity })],
    ['stepFiniteError', validParams({ step: Infinity })],
    ['correctValueFiniteError', validParams({ correctValue: Infinity })],
    ['acceptedToleranceFiniteError', validParams({ acceptedTolerance: Infinity })],
    ['minimumMaximumError', validParams({ minimum: 4, maximum: 4, correctValue: 4 })],
    ['stepPositiveError', validParams({ step: 0 })],
    ['toleranceNonNegativeError', validParams({ acceptedTolerance: -1 })],
    ['correctValueRangeError', validParams({ correctValue: 5 })],
    ['safeIntegerError', validParams({ maximum: 1e16 })],
    ['correctValueReachableError', validParams({ step: 2, correctValue: 1 })],
    ['acceptedIntervalError', validParams({
      minimum: 0, maximum: 1, step: 2, correctValue: 1, acceptedTolerance: 0.05
    })]
  ];

  cases.forEach(([messageKey, params]) => {
    const indexedKeys = [
      'customPointValueRequiredError', 'customPointValueLengthError',
      'customPointLabelTypeError', 'customPointLabelLengthError'
    ];
    const localized = `Localized ${messageKey}` + (indexedKeys.includes(messageKey) ? ' @index' : '');
    params.l10n = { [messageKey]: localized };
    const expected = localized.replace('@index', '1');
    assert.ok(
      H5P.ScaleQuestion.validateParameters(params).includes(expected),
      messageKey
    );
  });
});

test('configuration error rendering localizes the prefix and does not expose internal field names', () => {
  const { instance, calls } = createInstance(validParams({
    minimum: Infinity,
    l10n: {
      configurationErrorPrefix: 'Erreur de configuration :',
      minimumFiniteError: 'La valeur minimale doit être un nombre fini.'
    }
  }));
  attach(instance);
  assert.equal(
    calls.contents[0].textValue,
    'Erreur de configuration : La valeur minimale doit être un nombre fini.'
  );
  assert.doesNotMatch(calls.contents[0].textValue, /\bminimum\b/);
});

test('accepted tolerance feedback uses its localized template and placeholder', () => {
  const { instance, calls } = createInstance(validParams({
    correctValue: 2,
    acceptedTolerance: 1,
    l10n: {
      correctFeedback: 'Juste !',
      acceptedToleranceFeedback: 'Tolérance acceptée : ±@tolerance.'
    }
  }));
  attach(instance);
  instance.selectPosition(1);
  instance.checkAnswer();
  assert.equal(calls.feedback.at(-1)[0], 'Juste ! Tolérance acceptée : ±1.');
});

test('singular and plural attempt feedback use complete localized templates', () => {
  [
    { maxAttempts: 2, expected: 'Encore 1 tentative.' },
    { maxAttempts: 3, expected: 'Encore 2 tentatives.' }
  ].forEach(({ maxAttempts, expected }) => {
    const { instance, calls } = createInstance(validParams({
      maxAttempts,
      l10n: {
        incorrectFeedbackSingular: 'Encore @remaining tentative.',
        incorrectFeedbackPlural: 'Encore @remaining tentatives.'
      }
    }));
    attach(instance);
    instance.selectPosition(1);
    instance.checkAnswer();
    assert.equal(calls.feedback.at(-1)[0], expected);
  });

  const partial = createInstance(validParams({ l10n: { correctFeedback: 'Right.' } }));
  assert.equal(
    partial.instance.params.l10n.incorrectFeedbackSingular,
    'Incorrect. @remaining attempt remaining.'
  );
  assert.equal(
    partial.instance.params.l10n.incorrectFeedbackPlural,
    'Incorrect. @remaining attempts remaining.'
  );

  const terminal = createInstance(validParams({
    maxAttempts: 1,
    l10n: { terminalIncorrectFeedback: 'Aucune tentative restante.' }
  }));
  attach(terminal.instance);
  terminal.instance.selectPosition(1);
  terminal.instance.checkAnswer();
  assert.equal(terminal.calls.feedback.at(-1)[0], 'Aucune tentative restante.');
});

test('localized fallback title is used only when metadata has no title', () => {
  assert.equal(
    createInstance(validParams({ l10n: { defaultTitle: 'Question graduée' } })).instance.getTitle(),
    'Question graduée'
  );
  assert.equal(
    createInstance(
      validParams({ l10n: { defaultTitle: 'Question graduée' } }),
      { metadata: { title: 'Titre auteur' } }
    ).instance.getTitle(),
    'Titre auteur'
  );
});

test('xAPI descriptions use normalized metadata language for numerical and custom questions', () => {
  const numerical = createInstance(validParams(), { metadata: { defaultLanguage: 'FR-fr' } });
  attach(numerical.instance);
  numerical.instance.selectPosition(2);
  numerical.instance.checkAnswer();
  assert.equal(xAPIEvents(numerical.calls).length, 1);
  const numericalStatement = xAPIEvents(numerical.calls)[0].data.statement;
  const numericalDefinition = numericalStatement.object.definition;
  assert.deepEqual(plain(numericalDefinition.description), { 'fr-FR': 'Choose two' });
  assert.equal(numericalDefinition.interactionType, 'numeric');
  assert.equal(numericalStatement.result.response, '2');
  assert.equal(numericalStatement.result.completion, true);
  assert.equal(numericalStatement.result.success, true);
  assert.equal(numericalStatement.result.score.raw, 1);
  assert.equal(numericalStatement.result.score.max, 1);

  const custom = createInstance(
    validCustomParams({ question: '<p>Choose one point</p>' }),
    { metadata: { defaultLanguage: 'zh-hant-tw' } }
  );
  custom.instance.selectPosition(2);
  const customDefinition = custom.instance.getXAPIData().statement.object.definition;
  assert.deepEqual(plain(customDefinition.description), { 'zh-Hant-TW': 'Choose one point' });
  customDefinition.choices.forEach((choice) => {
    assert.deepEqual(Object.keys(choice.description), ['zh-Hant-TW']);
  });
  assert.equal(customDefinition.interactionType, 'choice');
  assert.deepEqual(plain(customDefinition.correctResponsesPattern), ['point-2']);
});

test('missing or invalid metadata language uses the safe English xAPI fallback', () => {
  [undefined, null, '', 'e', 'en--US', 'not_valid'].forEach((defaultLanguage) => {
    const metadata = defaultLanguage === undefined ? {} : { defaultLanguage };
    const { instance } = createInstance(validParams(), { metadata });
    const definition = instance.getXAPIData().statement.object.definition;
    assert.deepEqual(plain(definition.description), { en: 'Choose two' });
  });
});

test('French language file is valid and mirrors the complete translatable semantics tree', () => {
  assert.doesNotThrow(() => JSON.parse(frenchSource));
  assert.deepEqual(Object.keys(french), ['semantics']);
  assert.equal(french.semantics.length, semantics.length);

  const verifyNode = (englishNode, frenchNode, location) => {
    assert.equal(typeof frenchNode, 'object', location);
    assert.notEqual(frenchNode, null, location);

    if (typeof englishNode.label === 'string') {
      assert.equal(typeof frenchNode.label, 'string', `${location}.label`);
      assert.notEqual(frenchNode.label.trim(), '', `${location}.label`);
    }
    else if (englishNode.label === 0) {
      assert.equal(frenchNode.label, undefined, `${location}.hiddenLabel`);
    }

    if (typeof englishNode.description === 'string') {
      assert.equal(typeof frenchNode.description, 'string', `${location}.description`);
      assert.notEqual(frenchNode.description.trim(), '', `${location}.description`);
    }
    if (typeof englishNode.entity === 'string') {
      assert.equal(typeof frenchNode.entity, 'string', `${location}.entity`);
      assert.notEqual(frenchNode.entity.trim(), '', `${location}.entity`);
    }

    if (Array.isArray(englishNode.fields)) {
      assert.ok(Array.isArray(frenchNode.fields), `${location}.fields`);
      assert.equal(frenchNode.fields.length, englishNode.fields.length, `${location}.fields`);
      englishNode.fields.forEach((field, index) => {
        verifyNode(field, frenchNode.fields[index], `${location}.fields[${index}]`);
      });
    }
    if (englishNode.field) {
      assert.equal(typeof frenchNode.field, 'object', `${location}.field`);
      verifyNode(englishNode.field, frenchNode.field, `${location}.field`);
    }
    if (Array.isArray(englishNode.options) && englishNode.options.every((option) =>
      option && typeof option === 'object')) {
      assert.ok(Array.isArray(frenchNode.options), `${location}.options`);
      assert.equal(frenchNode.options.length, englishNode.options.length, `${location}.options`);
      englishNode.options.forEach((option, index) => {
        assert.equal(typeof frenchNode.options[index].label, 'string', `${location}.options[${index}].label`);
        assert.notEqual(frenchNode.options[index].label.trim(), '', `${location}.options[${index}].label`);
      });
    }
  };

  semantics.forEach((field, index) => {
    verifyNode(field, french.semantics[index], `semantics[${index}]`);
  });
});

test('French translation preserves placeholders and excludes machine-readable semantics values', () => {
  const englishL10n = semantics.find((field) => field.name === 'l10n');
  const l10nIndex = semantics.indexOf(englishL10n);
  const frenchL10n = french.semantics[l10nIndex];
  const placeholders = (value) => (value.match(/[@:][A-Za-z]+/g) || []).sort();

  englishL10n.fields.forEach((field, index) => {
    if (typeof field.default !== 'string') return;
    assert.deepEqual(
      placeholders(frenchL10n.fields[index].default),
      placeholders(field.default),
      field.name
    );
  });

  const forbiddenKeys = new Set([
    'name', 'type', 'value', 'importance', 'optional', 'widget', 'showWhen',
    'common', 'min', 'max', 'step', 'defaultNum', 'enterMode', 'tags'
  ]);
  const inspectTranslation = (value, location = 'fr') => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => inspectTranslation(item, `${location}[${index}]`));
      return;
    }
    if (!value || typeof value !== 'object') return;
    Object.keys(value).forEach((key) => {
      assert.equal(forbiddenKeys.has(key), false, `${location}.${key}`);
      inspectTranslation(value[key], `${location}.${key}`);
    });
  };
  inspectTranslation(french);

  assert.deepEqual(
    semantics.find((field) => field.name === 'scaleMode').options.map((option) => option.value),
    ['numerical', 'customPoints']
  );
  assert.deepEqual(
    semantics.find((field) => field.name === 'orientation').options.map((option) => option.value),
    ['horizontal', 'vertical']
  );
});

test('French covers every active l10n default and every configuration error', () => {
  const englishL10n = semantics.find((field) => field.name === 'l10n');
  const frenchL10n = french.semantics[semantics.indexOf(englishL10n)];
  const englishDefaults = Object.fromEntries(englishL10n.fields.flatMap((field) =>
    typeof field.default === 'string' ? [[field.name, field.default]] : []));
  const translatedDefaults = Object.fromEntries(englishL10n.fields.map((field, index) => [
    field.name,
    frenchL10n.fields[index].default
  ]));

  assert.deepEqual(englishDefaults, {
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
    correctValueFiniteError: 'Correct answer must be a finite number.',
    acceptedToleranceFiniteError: 'Accepted tolerance must be a finite number.',
    minimumMaximumError: 'Minimum must be less than maximum.',
    stepPositiveError: 'Selectable step must be positive.',
    toleranceNonNegativeError: 'Accepted tolerance must be non-negative.',
    correctValueRangeError: 'Correct answer must be within the selectable domain.',
    safeIntegerError: 'Numerical scale values exceed the safe integer domain.',
    correctValueReachableError: 'Correct answer must be reachable from minimum using the selectable step.',
    acceptedIntervalError: 'Accepted interval must contain at least one selectable slider position.'
  });

  englishL10n.fields.forEach((field) => {
    assert.equal(typeof translatedDefaults[field.name], 'string', field.name);
    assert.notEqual(translatedDefaults[field.name].trim(), '', field.name);
  });

  [
    'configurationErrorPrefix', 'maxAttemptsError', 'customPointsCountError',
    'customPointValueRequiredError', 'customPointValueLengthError',
    'customPointLabelTypeError', 'customPointLabelLengthError',
    'customPointCorrectCountError', 'minimumFiniteError', 'maximumFiniteError',
    'stepFiniteError', 'correctValueFiniteError', 'acceptedToleranceFiniteError',
    'minimumMaximumError', 'stepPositiveError', 'toleranceNonNegativeError',
    'correctValueRangeError', 'safeIntegerError', 'correctValueReachableError',
    'acceptedIntervalError'
  ].forEach((name) => {
    const englishField = englishL10n.fields.find((field) => field.name === name);
    assert.notEqual(translatedDefaults[name], englishField.default, name);
  });

  assert.equal(translatedDefaults.incorrectFeedbackSingular, 'Incorrect. Il reste @remaining tentative.');
  assert.equal(translatedDefaults.incorrectFeedbackPlural, 'Incorrect. Il reste @remaining tentatives.');
  assert.equal(translatedDefaults.terminalIncorrectFeedback, 'Incorrect. Il ne reste aucune tentative.');
  assert.equal(translatedDefaults.correctAnswer, 'Bonne réponse : @value');
  assert.equal(translatedDefaults.defaultTitle, 'Question sur une échelle');
});

test('French uses the approved increment, correct-answer, custom-point, and feedback terminology', () => {
  const translatedTopLevel = (name) => french.semantics[
    semantics.findIndex((field) => field.name === name)
  ];
  const englishL10n = semantics.find((field) => field.name === 'l10n');
  const frenchL10n = translatedTopLevel('l10n');
  const translatedL10n = (name) => frenchL10n.fields[
    englishL10n.fields.findIndex((field) => field.name === name)
  ];

  assert.equal(translatedTopLevel('step').label, "Valeur d'incrément");
  assert.deepEqual(translatedL10n('stepFiniteError'), {
    label: "Erreur ! Valeur d'incrément invalide.",
    default: "La valeur de l'incrément doit être un nombre."
  });
  assert.deepEqual(translatedL10n('stepPositiveError'), {
    label: "Erreur ! La valeur d'incrément entrée n'est pas un nombre positif.",
    default: "La valeur d'incrément doit être un nombre positif."
  });
  assert.match(translatedL10n('correctValueReachableError').default, /valeur d'incrément/);
  assert.doesNotMatch(translatedL10n('correctValueReachableError').default, /pas sélectionnable/);

  assert.equal(translatedTopLevel('correctValue').label, 'Réponse correcte');
  assert.equal(
    translatedTopLevel('acceptedTolerance').description,
    'L’intervalle accepté s’étend de manière égale au-dessus et au-dessous de la réponse correcte. Toute position sélectionnable du curseur située dans cet intervalle inclusif est correcte. Une tolérance nulle exige une réponse sélectionnable exacte. Une tolérance positive permet à la réponse correcte de se situer entre deux positions sélectionnables.'
  );
  assert.deepEqual(translatedL10n('correctValueFiniteError'), {
    label: 'Erreur de réponse correcte non valide',
    default: 'La réponse correcte doit être un nombre fini.'
  });
  assert.deepEqual(translatedL10n('correctValueRangeError'), {
    label: 'Erreur de réponse correcte hors du domaine',
    default: 'La réponse correcte doit se situer dans le domaine sélectionnable.'
  });
  assert.equal(
    translatedL10n('correctValueReachableError').default,
    "La réponse correcte doit pouvoir être atteinte à partir de la valeur minimale avec la valeur d'incrément."
  );
  assert.doesNotMatch(frenchSource, /réponse de référence/i);

  const scaleMode = translatedTopLevel('scaleMode');
  const customPoints = translatedTopLevel('customPoints');
  assert.equal(scaleMode.options[1].label, 'Points de référence personnalisés');
  assert.equal(customPoints.label, 'Points de référence personnalisés');
  assert.equal(customPoints.entity, 'point de référence');
  assert.equal(customPoints.field.label, 'Point de référence');
  assert.match(
    customPoints.description,
    /Sur un mode d'échelle avec des points de référence personnalisés, cette liste ne sera pas ordonnée automatiquement\./
  );
  assert.match(
    customPoints.description,
    /Cochez un seul point comme étant la réponse correcte attendue\./
  );
  assert.equal(
    translatedL10n('customScaleLabel').label,
    'Libellé accessible de l’échelle à points de référence personnalisés'
  );
  assert.equal(
    translatedL10n('customScaleLabel').default,
    'Échelle à points de référence personnalisés'
  );

  [
    'customPointsCountError', 'customPointValueRequiredError',
    'customPointValueLengthError', 'customPointLabelTypeError',
    'customPointLabelLengthError', 'customPointCorrectCountError'
  ].forEach((name) => {
    assert.match(
      translatedL10n(name).label + ' ' + translatedL10n(name).default,
      /point[s]? de référence/i,
      name
    );
    assert.doesNotMatch(
      translatedL10n(name).label + ' ' + translatedL10n(name).default,
      /point[s]? personnalisés?/i,
      name
    );
  });

  ['feedbackBelowCorrect', 'feedbackAboveCorrect'].forEach((name) => {
    assert.match(translatedTopLevel(name).label, /^Feedback\b/);
  });
  [
    'correctFeedback', 'incorrectFeedbackSingular', 'incorrectFeedbackPlural',
    'terminalIncorrectFeedback', 'acceptedToleranceFeedback'
  ].forEach((name) => {
    assert.match(translatedL10n(name).label, /^Feedback\b/, name);
  });
});

test('French keeps autoCheck compatibility hidden and common localization switchable', () => {
  const behaviourIndex = semantics.findIndex((field) => field.name === 'behaviour');
  const englishBehaviour = semantics[behaviourIndex];
  const frenchBehaviour = french.semantics[behaviourIndex];
  const autoCheckIndex = englishBehaviour.fields.findIndex((field) => field.name === 'autoCheck');
  const legacyCheckIndex = englishBehaviour.fields.findIndex((field) => field.name === 'enableCheckButton');

  assert.equal(
    frenchBehaviour.fields[autoCheckIndex].label,
    'Vérifier automatiquement les réponses après la sélection'
  );
  assert.equal(frenchBehaviour.fields[autoCheckIndex].default, undefined);
  assert.equal(englishBehaviour.fields[autoCheckIndex].default, false);
  assert.deepEqual(frenchBehaviour.fields[legacyCheckIndex], {});
  assert.equal(englishBehaviour.fields[legacyCheckIndex].widget, 'none');
  assert.equal(englishBehaviour.fields[legacyCheckIndex].label, undefined);

  const englishL10n = semantics.find((field) => field.name === 'l10n');
  const frenchL10n = french.semantics[semantics.indexOf(englishL10n)];
  assert.equal(englishL10n.fields.some((field) => field.name === 'incorrectFeedback'), false);
  assert.equal(englishL10n.fields.some((field) => field.widget === 'none'), false);
  assert.equal(frenchL10n.fields.length, englishL10n.fields.length);
});

test('French l10n defaults are consumed without changing attempts, scoring, or xAPI completion', () => {
  const englishL10n = semantics.find((field) => field.name === 'l10n');
  const frenchL10nTree = french.semantics[semantics.indexOf(englishL10n)];
  const frenchL10n = Object.fromEntries(englishL10n.fields.flatMap((field, index) =>
    typeof frenchL10nTree.fields[index].default === 'string' ?
      [[field.name, frenchL10nTree.fields[index].default]] : []));
  const { instance, calls } = createInstance(validParams({ l10n: frenchL10n }));
  attach(instance);

  assert.equal(calls.buttons['check-answer'].label, 'Vérifier');
  assert.equal(calls.buttons['try-again'].label, 'Réessayer');
  assert.equal(calls.buttons['show-solution'].label, 'Afficher la solution');
  instance.selectPosition(1);
  assert.equal(instance.checkAnswer(), false);
  assert.equal(calls.feedback.at(-1)[0], 'Incorrect. Il reste 1 tentative.');
  assert.equal(instance.attemptsUsed, 1);
  assert.equal(xAPIEvents(calls).length, 0);

  instance.retryTask();
  instance.selectPosition(2);
  assert.equal(instance.checkAnswer(), true);
  assert.equal(instance.getScore(), 1);
  assert.equal(instance.isCompleted(), true);
  assert.equal(xAPIEvents(calls).length, 1);
  assert.equal(xAPIEvents(calls)[0].data.statement.result.response, '2');
  assert.equal(xAPIEvents(calls)[0].data.statement.result.completion, true);
});

test('omitted and explicit false autoCheck require Check and do not submit on selection', () => {
  const omittedParams = validParams();
  delete omittedParams.behaviour.autoCheck;
  [omittedParams, validParams({ behaviour: { autoCheck: false } })].forEach((params) => {
    const { instance, calls } = createInstance(params);
    attach(instance);
    instance.selectPosition(2);
    assert.equal(instance.params.behaviour.autoCheck, false);
    assert.equal(instance.attemptsUsed, 0);
    assert.equal(calls.buttons['check-answer'].visible, true);
    assert.equal(xAPIEvents(calls).length, 0);
    instance.checkAnswer();
    assert.equal(instance.getScore(), 1);
    assert.equal(xAPIEvents(calls).length, 1);
  });
});

test('explicit true autoCheck hides Check and submits immediately', () => {
  const { instance, calls } = createInstance(validParams({ behaviour: { autoCheck: true } }));
  attach(instance);
  instance.selectPosition(2);
  assert.equal(instance.params.behaviour.autoCheck, true);
  assert.equal(instance.attemptsUsed, 1);
  assert.equal(instance.getScore(), 1);
  assert.equal(calls.buttons['check-answer'].visible, false);
  assert.equal(xAPIEvents(calls).length, 1);
});

test('legacy enableCheckButton values preserve their inverse runtime behavior', () => {
  [
    { enableCheckButton: true, expectedAutoCheck: false },
    { enableCheckButton: false, expectedAutoCheck: true }
  ].forEach(({ enableCheckButton, expectedAutoCheck }) => {
    const params = validParams();
    params.behaviour = { enableCheckButton, enableRetry: true, enableSolutionsButton: true };
    const { instance, calls } = createInstance(params);
    attach(instance);
    instance.selectPosition(2);
    assert.equal(instance.params.behaviour.autoCheck, expectedAutoCheck);
    assert.equal(instance.attemptsUsed, expectedAutoCheck ? 1 : 0);
    assert.equal(calls.buttons['check-answer'].visible, !expectedAutoCheck);
    if (!expectedAutoCheck) {
      instance.checkAnswer();
    }
    assert.equal(instance.getScore(), 1);
    assert.equal(xAPIEvents(calls).length, 1);
  });
});

test('explicit autoCheck takes precedence when both new and legacy parameters exist', () => {
  [
    { autoCheck: false, enableCheckButton: false },
    { autoCheck: true, enableCheckButton: true }
  ].forEach((behaviour) => {
    const { instance, calls } = createInstance(validParams({ behaviour }));
    attach(instance);
    instance.selectPosition(2);
    assert.equal(instance.params.behaviour.autoCheck, behaviour.autoCheck);
    assert.equal(instance.attemptsUsed, behaviour.autoCheck ? 1 : 0);
    assert.equal(calls.buttons['check-answer'].visible, !behaviour.autoCheck);
  });
});

test('H5P editor default insertion makes autoCheck explicit without deleting the hidden legacy value', () => {
  const legacyParams = validParams();
  legacyParams.behaviour = {
    enableCheckButton: false,
    enableRetry: true,
    enableSolutionsButton: true
  };
  const initialized = applyEditorDefaults(semantics, plain(legacyParams));
  assert.equal(initialized.behaviour.autoCheck, false);
  assert.equal(initialized.behaviour.enableCheckButton, false);

  const { instance, calls } = createInstance(initialized);
  attach(instance);
  instance.selectPosition(2);
  assert.equal(instance.params.behaviour.autoCheck, false);
  assert.equal(instance.attemptsUsed, 0);
  assert.equal(calls.buttons['check-answer'].visible, true);
});

test('autoCheck submits numerical and custom selections in both orientations', () => {
  ['horizontal', 'vertical'].forEach((orientation) => {
    [validParams, validCustomParams].forEach((factory) => {
      const { instance, calls } = createInstance(factory({
        orientation,
        behaviour: { autoCheck: true }
      }));
      attach(instance);
      instance.selectPosition(2);
      assert.equal(instance.terminal, true);
      assert.equal(instance.getScore(), 1);
      assert.equal(calls.buttons['check-answer'].visible, false);
      assert.equal(xAPIEvents(calls).length, 1);
    });
  });
});

test('autoCheck preserves Retry-enabled and Retry-disabled lifecycles', () => {
  const retryEnabled = createInstance(validParams({
    maxAttempts: 2,
    behaviour: { autoCheck: true, enableRetry: true }
  }));
  attach(retryEnabled.instance);
  retryEnabled.instance.selectPosition(1);
  assert.equal(retryEnabled.instance.awaitingRetry, true);
  assert.equal(retryEnabled.instance.terminal, false);
  assert.equal(retryEnabled.calls.buttons['try-again'].visible, true);
  assert.equal(xAPIEvents(retryEnabled.calls).length, 0);

  const retryDisabled = createInstance(validParams({
    maxAttempts: 2,
    behaviour: { autoCheck: true, enableRetry: false }
  }));
  attach(retryDisabled.instance);
  retryDisabled.instance.selectPosition(1);
  assert.equal(retryDisabled.instance.awaitingRetry, false);
  assert.equal(retryDisabled.instance.terminal, true);
  assert.equal(retryDisabled.calls.buttons['try-again'].visible, false);
  assert.equal(retryDisabled.calls.buttons['show-solution'].visible, true);
  assert.equal(xAPIEvents(retryDisabled.calls).length, 1);
});

test('saved terminal state restores identically with autoCheck without replaying xAPI', () => {
  const params = validParams({ behaviour: { autoCheck: true, enableRetry: false } });
  const original = createInstance(params);
  attach(original.instance);
  original.instance.selectPosition(1);
  const state = plain(original.instance.getCurrentState());

  const restored = createInstance(params, { previousState: state });
  attach(restored.instance);
  assert.equal(restored.instance.terminal, true);
  assert.equal(restored.instance.selectedIndex, 1);
  assert.equal(restored.instance.getScore(), 0);
  assert.equal(restored.calls.buttons['check-answer'].visible, false);
  assert.equal(restored.calls.buttons['try-again'].visible, false);
  assert.equal(restored.calls.buttons['show-solution'].visible, true);
  assert.equal(xAPIEvents(restored.calls).length, 0);
});

test('autoCheck changes only submission timing, not score, solution, or terminal xAPI', () => {
  [false, true].forEach((autoCheck) => {
    const { instance, calls } = createInstance(validParams({
      maxAttempts: 2,
      behaviour: { autoCheck, enableRetry: false, enableSolutionsButton: true }
    }));
    attach(instance);
    instance.selectPosition(1);
    if (!autoCheck) {
      assert.equal(instance.attemptsUsed, 0);
      instance.checkAnswer();
    }
    assert.equal(instance.attemptsUsed, 1);
    assert.equal(instance.getScore(), 0);
    assert.equal(instance.terminal, true);
    assert.equal(calls.buttons['show-solution'].visible, true);
    assert.equal(xAPIEvents(calls).length, 1);
    instance.showSolutions();
    assert.equal(instance.solutionVisible, true);
    assert.equal(instance.getScore(), 0);
    assert.equal(xAPIEvents(calls).length, 1);
  });
});
