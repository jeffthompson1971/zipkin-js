const sinon = require('sinon');
const lolex = require('lolex');
const Tracer = require('../src/tracer');
const BatchRecorder = require('../src/batch-recorder');
const TraceId = require('../src/tracer/TraceId');
const Annotation = require('../src/annotation');
const InetAddress = require('../src/InetAddress');
const {Some} = require('../src/option');
const ExplicitContext = require('../src/explicit-context');

describe('Batch Recorder', () => {
  it('should accumulate annotations into PartialSpans', () => {
    const logSpan = sinon.spy();

    const ctxImpl = new ExplicitContext();
    const logger = {logSpan};
    const recorder = new BatchRecorder({logger});
    const trace = new Tracer({ctxImpl, recorder});

    ctxImpl.scoped(() => {
      trace.setId(new TraceId({
        traceId: 'a',
        parentId: new Some('a'),
        spanId: 'c',
        sampled: new Some(true)
      }));

      trace.recordServiceName('SmoothieStore');
      trace.recordRpc('buySmoothie');
      trace.recordBinary('taste', 'banana');
      trace.recordAnnotation(new Annotation.ServerRecv());
      trace.recordAnnotation(new Annotation.LocalAddr({
        host: new InetAddress('127.0.0.1'),
        port: 7070
      }));

      // Should only log after the span is complete
      expect(logSpan.calledOnce).to.equal(false);
      trace.recordAnnotation(new Annotation.ServerSend());
      expect(logSpan.calledOnce).to.equal(true);

      const loggedSpan = logSpan.getCall(0).args[0];

      expect(loggedSpan.traceId).to.equal('a');
      expect(loggedSpan.parentId).to.equal('a');
      expect(loggedSpan.id).to.equal('c');
      expect(loggedSpan.name).to.eql('buysmoothie');
      expect(loggedSpan.kind).to.equal('SERVER');
      expect(loggedSpan.localEndpoint.serviceName).to.equal('smoothiestore');
      expect(loggedSpan.localEndpoint.ipv4).to.equal('127.0.0.1');
      expect(loggedSpan.localEndpoint.port).to.equal(7070);
      expect(loggedSpan.tags.taste).to.equal('banana');
    });
  });

  // Applications can override the span name via trace.recordRpc
  it('should record span name as last recordRpc', () => {
    const logSpan = sinon.spy();

    const ctxImpl = new ExplicitContext();
    const logger = {logSpan};
    const recorder = new BatchRecorder({logger});
    const trace = new Tracer({ctxImpl, recorder});

    ctxImpl.scoped(() => {
      trace.setId(new TraceId({
        traceId: 'a',
        parentId: new Some('a'),
        spanId: 'c',
        sampled: new Some(true)
      }));

      trace.recordServiceName('SmoothieStore');
      trace.recordRpc('buySmoothie');
      trace.recordAnnotation(new Annotation.ServerRecv());

      // some customization code scoped to this trace ID resets the span name
      trace.recordRpc('rentSmoothie');

      trace.recordAnnotation(new Annotation.ServerSend());

      const loggedSpan = logSpan.getCall(0).args[0];

      expect(loggedSpan.name).to.eql('rentsmoothie');
    });
  });

  it('should copy shared flag from trace id', () => {
    const logSpan = sinon.spy();

    const ctxImpl = new ExplicitContext();
    const logger = {logSpan};
    const recorder = new BatchRecorder({logger});
    const trace = new Tracer({ctxImpl, recorder});

    ctxImpl.scoped(() => {
      trace.setId(new TraceId({
        traceId: 'a',
        parentId: new Some('a'),
        spanId: 'c',
        sampled: new Some(true),
        shared: true
      }));

      trace.recordServiceName('SmoothieStore');
      trace.recordRpc('buySmoothie');
      trace.recordAnnotation(new Annotation.ServerRecv());
      trace.recordAnnotation(new Annotation.ServerSend());

      const loggedSpan = logSpan.getCall(0).args[0];

      expect(loggedSpan.shared).to.equal(true);
    });
  });

  it('should set Span.timestamp to first record', () => {
    const clock = lolex.install(12345678);
    const logSpan = sinon.spy();

    const ctxImpl = new ExplicitContext();
    const logger = {logSpan};
    const recorder = new BatchRecorder({logger});
    const trace = new Tracer({ctxImpl, recorder});

    ctxImpl.scoped(() => {
      trace.setId(new TraceId({
        traceId: 'a',
        spanId: 'c',
        sampled: new Some(true)
      }));
      trace.recordServiceName('SmoothieStore');
      trace.recordRpc('buySmoothie');
      trace.recordBinary('taste', 'banana');
      trace.recordAnnotation(new Annotation.ServerRecv());
      trace.recordAnnotation(new Annotation.ServerSend());

      const loggedSpan = logSpan.getCall(0).args[0];

      expect(loggedSpan.timestamp).to.equal(12345678000);

      clock.uninstall();
    });
  });

  it('should record duration in microseconds', () => {
    // This test is failing under the browser zipkin-js/#315
    if (typeof window !== 'undefined') {
      return;
    }

    const clock = lolex.install(12345678);
    const logSpan = sinon.spy();

    const ctxImpl = new ExplicitContext();
    const logger = {logSpan};
    const recorder = new BatchRecorder({logger});
    const trace = new Tracer({ctxImpl, recorder});

    ctxImpl.scoped(() => {
      trace.setId(new TraceId({
        traceId: 'a',
        spanId: 'c',
        sampled: new Some(true)
      }));
      trace.recordRpc('GET');
      trace.recordAnnotation(new Annotation.ClientSend());
      clock.tick(0.123456);
      trace.recordAnnotation(new Annotation.ClientRecv());

      const loggedSpan = logSpan.getCall(0).args[0];

      expect(loggedSpan.timestamp).to.equal(12345678000);
      expect(loggedSpan.duration).to.equal(123);

      clock.uninstall();
    });
  });

  it('should flush Spans not finished within a minute timeout', () => {
    const clock = lolex.install();

    const logSpan = sinon.spy();
    const ctxImpl = new ExplicitContext();
    const logger = {logSpan};
    const recorder = new BatchRecorder({logger});
    const trace = new Tracer({ctxImpl, recorder});
    const traceId = new TraceId({
      traceId: 'a',
      parentId: new Some('a'),
      spanId: 'c',
      sampled: new Some(true)
    });

    ctxImpl.scoped(() => {
      trace.setId(traceId);

      trace.recordServiceName('SmoothieStore');
      trace.recordAnnotation(new Annotation.ServerRecv());
    });

    clock.tick('02'); // polling interval is every second
    expect(logSpan.calledOnce).to.equal(false);

    clock.tick('01:00'); // 1 minute is the default timeout
    expect(logSpan.calledOnce).to.equal(true);

    ctxImpl.scoped(() => {
      trace.setId(traceId);

      // ServerSend terminates the span, but it's already expired.
      // Span is dropped silently.
      trace.recordAnnotation(new Annotation.ServerSend());
    });

    clock.uninstall();
  });

  it('should capture ServerAddr event', () => {
    const logSpan = sinon.spy();

    const ctxImpl = new ExplicitContext();
    const logger = {logSpan};
    const recorder = new BatchRecorder({logger});
    const trace = new Tracer({ctxImpl, recorder});

    ctxImpl.scoped(() => {
      trace.setId(new TraceId({
        traceId: 'a',
        parentId: new Some('a'),
        spanId: 'c',
        sampled: new Some(true)
      }));
      trace.recordServiceName('client');
      trace.recordRpc('call');
      trace.recordAnnotation(new Annotation.ClientSend());
      trace.recordAnnotation(new Annotation.ServerAddr({
        serviceName: 'server',
        host: new InetAddress('127.0.0.2'),
        port: 7071
      }));
      trace.recordAnnotation(new Annotation.ClientRecv());

      const loggedSpan = logSpan.getCall(0).args[0];
      expect(loggedSpan.remoteEndpoint.serviceName).to.equal('server');
      expect(loggedSpan.remoteEndpoint.ipv4).to.equal('127.0.0.2');
      expect(loggedSpan.remoteEndpoint.port).to.equal(7071);
    });
  });

  it('should capture MessageAddr event', () => {
    const logSpan = sinon.spy();

    const ctxImpl = new ExplicitContext();
    const logger = {logSpan};
    const recorder = new BatchRecorder({logger});
    const trace = new Tracer({ctxImpl, recorder});

    ctxImpl.scoped(() => {
      trace.setId(new TraceId({
        traceId: 'a',
        parentId: new Some('a'),
        spanId: 'c',
        sampled: new Some(true)
      }));
      trace.recordServiceName('producer');
      trace.recordRpc('send-msg');
      trace.recordAnnotation(new Annotation.ProducerStart());
      trace.recordAnnotation(new Annotation.MessageAddr({
        serviceName: 'mq',
        host: new InetAddress('127.0.0.2'),
        port: 7072
      }));
      trace.recordAnnotation(new Annotation.ProducerStop());

      const loggedSpan = logSpan.getCall(0).args[0];
      expect(loggedSpan.remoteEndpoint.serviceName).to.equal('mq');
      expect(loggedSpan.remoteEndpoint.ipv4).to.equal('127.0.0.2');
      expect(loggedSpan.remoteEndpoint.port).to.equal(7072);
    });
  });

  it('should capture tracer defaultTags', () => {
    const logSpan = sinon.spy();

    const ctxImpl = new ExplicitContext();
    const logger = {logSpan};
    const recorder = new BatchRecorder({logger});
    const defaultTags = {instanceId: 'i-1234567890abcdef0', cluster: 'nodeservice-stage'};
    const trace = new Tracer({ctxImpl, recorder, defaultTags});

    trace.recordServiceName('producer');
    trace.recordRpc('send-msg');
    trace.recordAnnotation(new Annotation.LocalOperationStart());
    trace.recordAnnotation(new Annotation.LocalOperationStop());

    const loggedSpan = logSpan.getCall(0).args[0];
    expect(loggedSpan.tags.instanceId).to.equal(defaultTags.instanceId);
    expect(loggedSpan.tags.cluster).to.equal(defaultTags.cluster);
  });

  it('should capture tracer defaultTags on local scope', () => {
    const logSpan = sinon.spy();

    const ctxImpl = new ExplicitContext();
    const logger = {logSpan};
    const recorder = new BatchRecorder({logger});
    const defaultTags = {instanceId: 'i-1234567890abcdef0', cluster: 'nodeservice-stage'};
    const trace = new Tracer({ctxImpl, recorder, defaultTags});

    ctxImpl.scoped(() => {
      trace.setId(new TraceId({
        traceId: 'a',
        parentId: new Some('a'),
        spanId: 'c',
        sampled: new Some(true)
      }));
      trace.recordServiceName('producer');
      trace.recordRpc('send-msg');
      trace.recordAnnotation(new Annotation.LocalOperationStart());
      trace.recordAnnotation(new Annotation.LocalOperationStop());

      const loggedSpan = logSpan.getCall(0).args[0];
      expect(loggedSpan.tags.instanceId).to.equal(defaultTags.instanceId);
      expect(loggedSpan.tags.cluster).to.equal(defaultTags.cluster);
    });
  });
});
