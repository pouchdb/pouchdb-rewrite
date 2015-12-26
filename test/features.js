import {setup, rewriteDocument, teardown, shouldThrowError, checkUuid} from './utils';

let db;

describe('Async rewrite tests', () => {
  beforeEach(done => {
    db = setup();
    db.put(rewriteDocument, done);
  });
  afterEach(teardown);

  it('basic url', done => {
    db.rewriteResultRequestObject('test/test/all', {query: {'k': 'v'}}, (err, req) => {
      req.raw_path.should.equal('/test/_design/test/_list/test/ids?k=v');
      done(err);
    });
  });

  it('basic resp', done => {
    db.rewrite('test/test/all', err => {
      err.status.should.equal(404);
      err.name.should.equal('not_found');
      err.message.should.contain('view named ids');

      done();
    });
  });
});

describe('sync rewrite tests', () => {
  beforeEach(() => {
    db = setup();
  });
  afterEach(teardown);

  function putRewrites(rewrites) {
    return db.put({
      _id: '_design/test',
      rewrites: rewrites
    });
  }

  it('empty from rewrite', async () => {
    await putRewrites([
      {
        to: '_show/redirect',
        from: ''
      },
      {
        to: '_show/page/*',
        from: '/page/*'
      }
    ]);
    const path = (await db.rewriteResultRequestObject('test/page/index')).path;
    path.should.eql(['test', '_design', 'test', '_show', 'page', 'index']);
  });

  it('missing from rewrite', async () => {
    await putRewrites([
       {
         to: '1234mytest'
       }
    ]);
    const path = (await db.rewriteResultRequestObject('test/abc')).path;
    path.should.eql(['test', '_design', 'test', '1234mytest']);
    const err = await shouldThrowError(async () => {
      await db.rewrite('test');
    })
    err.status.should.equal(404);
  });

  it('high up path', async () => {
    await putRewrites([{
      from: '/highup',
      // should be sufficiently high up.
      to: '../../../../../..'
    }]);
    const err = await shouldThrowError(async () => {
      await db.rewrite('test/highup');
    });

    err.status.should.equal(404);
    err.message.should.equal('missing');
  });

  it('bad path', async () => {
    putRewrites([{from: '/badpath', to: '../../a/b/c'}]);
    const err = await shouldThrowError(async () => {
      await db.rewrite('test/badpath');
    });
    err.status.should.equal(404);
  });

  it('attachment rewrite', async () => {
    const ddocResp = await putRewrites([{from: '/attachment', to: '/attachment'}]);
    // test if put succeeds
    const resp = await db.rewrite('test/attachment/', {
      method: 'PUT',
      withValidation: true,
      body: new Buffer('Hello World', 'ascii'),
      headers: {'Content-Type': 'text/plain'},
      query: {rev: ddocResp.rev}
    })
    resp.ok.should.be.ok;

    // test if delete succeeds
    const resp2 = await db.rewrite('test/attachment', {
      method: 'DELETE',
      withValidation: false,
      query: {rev: resp.rev}
    });
    resp2.ok.should.be.ok;

    // test if post gives a 405
    const err = await shouldThrowError(async () => {
      await db.rewrite('test/attachment', {
        method: 'POST',
        // not sure if it would be required. Playing safe here.
        // Not that it should ever reach the rev check.
        query: {rev: resp2.rev}
      })
    });
    err.status.should.equal(405);
    err.name.should.equal('method_not_allowed');
    err.message.should.contain('POST');
  });

  it('local doc rewrite', async () => {
    await putRewrites([{from: '/doc', to: '.././../_local/test'}]);
    const resp = await db.rewrite('test/doc', {
      method: 'PUT',
      body: '{"_id": "test"}',
      withValidation: true
    });
    resp.ok.should.be.ok;
  });

  it('all dbs rewrite', async () => {
    await putRewrites([{from: '/alldbs', to: '../../../_all_dbs'}]);
    const resp = await db.rewrite('test/alldbs');
    resp.should.be.instanceof(Array);

    const resp2  = await db.rewriteResultRequestObject('test/alldbs');
    resp2.path.should.eql(['_all_dbs']);
  });

  it('post doc rewrite', async () => {
    await putRewrites([{from: 'postdoc', to: '../../', method: 'POST'}]);

    const resp = await db.rewrite('test/postdoc', {body:'{}', method:'POST'});
    checkUuid(resp.id);
    resp.rev.indexOf('1-').should.equal(0);
    resp.ok.should.be.ok;

    const resp2 = await db.rewrite('test/postdoc', {body:'{}', method:'POST', withValidation: true});
    checkUuid(resp2.id);
    resp2.rev.indexOf('1-').should.equal(0);
    resp2.ok.should.be.ok;
  });

  it('post doc using double rewrite', async () => {
    await putRewrites([
      {from: 'rewrite1', to: '_rewrite/rewrite2'},
      // POST to an existing doc -> 405
      {from: 'rewrite2', to: '../../test', method: 'POST'}
    ]);

    const err = await shouldThrowError(async () => {
      await db.rewrite('test/rewrite1', {body: '{}'});
    });

    err.status.should.equal(405);
  });

  it('session rewrite', async () => {
    await putRewrites([{from: 'session', to: '../../../_session'}])

    // POST (401)
    const err = await shouldThrowError(async () => {
      await db.rewrite('test/session', {
        body: 'username=test&password=test',
        method: 'POST'
      });
    });

    err.status.should.equal(401);

    // PUT (405)
    const err2 = await shouldThrowError(async () => {
      await db.rewrite('test/session', {method: 'PUT'});
    });

    err2.status.should.equal(405);
  });

  it('security rewrite', async () => {
    await putRewrites([{from: 'security', to: '../../_security'}]);

    const resp = await db.rewrite('test/security');
    resp.should.eql({});

    const err = await shouldThrowError(async () => {
      await db.rewrite('test/security', {method: 'DELETE'});
    });

    err.status.should.equal(405);
  });

  it('replicate rewrite', async () => {
    await putRewrites([{from: 'replicate', to: '../../../_replicate'}]);

    const resp = await db.rewrite('test/replicate', {
      body: '{"source": "a", "target": "b"}'
    });
    resp.ok.should.be.ok;
    resp.status.should.equal('complete');
  });
});

describe('sync CouchDB based rewrite tests', () => {
  /*
    Based on CouchDB's rewrite test suite: rewrite.js. Not every test
    has yet been ported, but a large amount has been.

    Original test source:
    https://github.com/apache/couchdb/blob/master/test/javascript/tests/rewrite.js
  */

  before(async () => {
    db = setup();
    const designDoc = {
      _id: '_design/test',
      language: 'javascript',
      _attachments: {
        'foo.txt': {
          content_type: 'text/plain',
          data: 'VGhpcyBpcyBhIGJhc2U2NCBlbmNvZGVkIHRleHQ='
        }
      },
      rewrites: [
        {
          from: 'foo',
          to: 'foo.txt'
        },
        {
          from: 'foo2',
          to: 'foo.txt',
          method: 'GET'
        },
        {
          from: 'hello/:id',
          to: '_update/hello/:id',
          method: 'PUT'
        },
        {
          from: '/welcome',
          to: '_show/welcome'
        },
        {
          from: '/welcome/:name',
          to: '_show/welcome',
          query: {
            name: ':name'
          }
        },
        {
          from: '/welcome2',
          to: '_show/welcome',
          query: {
            name: 'user'
          }
        },
        {
          from: '/welcome3/:name',
          to: '_update/welcome2/:name',
          method: 'PUT'
        },
        {
          from: '/welcome3/:name',
          to: '_show/welcome2/:name',
          method: 'GET'
        },
        {
          from: '/welcome4/*',
          to : '_show/welcome3',
          query: {
            name: '*'
          }
        },
        {
          from: '/welcome5/*',
          to : '_show/*',
          query: {
            name: '*'
          }
        },
        {
          from: 'basicView',
          to: '_view/basicView'
        },
        {
          from: 'simpleForm/basicView',
          to: '_list/simpleForm/basicView'
        },
        {
          from: 'simpleForm/basicViewFixed',
          to: '_list/simpleForm/basicView',
          query: {
            startkey: 3,
            endkey: 8
          }
        },
        {
          from: 'simpleForm/basicViewPath/:start/:end',
          to: '_list/simpleForm/basicView',
          query: {
            startkey: ':start',
            endkey: ':end'
          },
          formats: {
            start: 'int',
            end: 'int'
          }
        },
        {
          from: 'simpleForm/complexView',
          to: '_list/simpleForm/complexView',
          query: {
            key: [1, 2]
          }
        },
        {
          from: 'simpleForm/complexView2',
          to: '_list/simpleForm/complexView',
          query: {
            key: ['test', {}]
          }
        },
        {
          from: 'simpleForm/complexView3',
          to: '_list/simpleForm/complexView',
          query: {
            key: ['test', ['test', 'essai']]
          }
        },
        {
          from: 'simpleForm/complexView4',
          to: '_list/simpleForm/complexView2',
          query: {
            key: {'c': 1}
          }
        },
        {
          from: 'simpleForm/complexView5/:a/:b',
          to: '_list/simpleForm/complexView3',
          query: {
            key: [':a', ':b']
          }
        },
        {
          from: 'simpleForm/complexView6',
          to: '_list/simpleForm/complexView3',
          query: {
            key: [':a', ':b']
          }
        },
        {
          from: 'simpleForm/complexView7/:a/:b',
          to: '_view/complexView3',
          query: {
            key: [':a', ':b'],
            include_docs: ':doc'
          },
          format: {
            doc: 'bool'
          }
        },
        {
          from: '/',
          to: '_view/basicView'
        },
        {
          from: '/db/*',
          to: '../../*'
        }
      ],
      lists: {
        simpleForm: `function(head, req) {
          log('simpleForm');
          send('<ul>');
          var row, row_number = 0, prevKey, firstKey = null;
          while (row = getRow()) {
            row_number += 1;
            if (!firstKey) firstKey = row.key;
            prevKey = row.key;
            send('\\n<li>Key: '+row.key
                 +' Value: '+row.value
                 +' LineNo: '+row_number+'</li>');
          }
          return '</ul><p>FirstKey: '+ firstKey + ' LastKey: '+ prevKey+'</p>';
        }`
      },
      shows: {
        welcome: `function(doc,req) {
          return 'Welcome ' + req.query['name'];
        }`,
        welcome2: `function(doc, req) {
          return 'Welcome ' + doc.name;
        }`,
        welcome3: `function(doc,req) {
          return 'Welcome ' + req.query['name'];
        }`
      },
      updates: {
        hello: `function(doc, req) {
          if (!doc) {
            if (req.id) {
              return [{
                _id : req.id
              }, 'New World']
            }
            return [null, 'Empty World'];
          }
          doc.world = 'hello';
          doc.edited_by = req.userCtx;
          return [doc, 'hello doc'];
        }`,
        welcome2: `function(doc, req) {
          if (!doc) {
            if (req.id) {
              return [{
                _id: req.id,
                name: req.id
              }, 'New World']
            }
            return [null, 'Empty World'];
          }
          return [doc, 'hello doc'];
        }`
      },
      views: {
        basicView: {
          map: `function(doc) {
            if (doc.integer) {
              emit(doc.integer, doc.string);
            }

          }`
        },
        complexView: {
          map: `function(doc) {
            if (doc.type == 'complex') {
              emit([doc.a, doc.b], doc.string);
            }
          }`
        },
        complexView2: {
          map: `function(doc) {
            if (doc.type == 'complex') {
              emit(doc.a, doc.string);
            }
          }`
        },
        complexView3: {
          map: `function(doc) {
            if (doc.type == 'complex') {
              emit(doc.b, doc.string);
            }
          }`
        }
      }
    }

    function makeDocs(start, end) {
      const docs = [];
      for (let i = start; i < end; i++) {
        docs.push({
          _id: i.toString(),
          integer: i,
          string: i.toString()
        });
      }
      return docs
    }

    const docs1 = makeDocs(0, 10);
    const docs2 = [
      {a: 1, b: 1, string: 'doc 1', type: 'complex'},
      {a: 1, b: 2, string: 'doc 2', type: 'complex'},
      {a: 'test', b: {}, string: 'doc 3', type: 'complex'},
      {a: 'test', b: ['test', 'essai'], string: 'doc 4', type: 'complex'},
      {a: {'c': 1}, b: '', string: 'doc 5', type: 'complex'}
    ];

    await db.bulkDocs([designDoc].concat(docs1).concat(docs2));
  });
  after(teardown);

  it('simple rewriting', async () => {
    // GET is the default http method
    const resp = await db.rewrite('test/foo');
    resp.toString('ascii').should.equal('This is a base64 encoded text');
    resp.type.should.equal('text/plain');

    const resp2 = await db.rewrite('test/foo2');
    resp2.toString('ascii').should.equal('This is a base64 encoded text');
    resp2.type.should.equal('text/plain');
  });

  it('basic update', async () => {
    // hello update world
    const doc = {word: 'plankton', name: 'Rusty'};
    const resp = await db.post(doc);
    resp.ok.should.be.ok;
    const docid = resp.id;

    const resp2 = await db.rewrite('test/hello/' + docid, {method: 'PUT'});
    resp2.code.should.equal(201);
    resp2.body.should.equal('hello doc');
    resp2.headers['Content-Type'].should.contain('charset=utf-8');

    const doc2 = await db.get(docid);
    doc2.world.should.equal('hello');
  });

  it('basic show', async () => {
    const resp = await db.rewrite('test/welcome', {query: {name: 'user'}});
    resp.body.should.equal('Welcome user');

    const resp2 = await db.rewrite('test/welcome/user');
    resp2.body.should.equal('Welcome user');

    const resp3 = await db.rewrite('test/welcome2');
    resp3.body.should.equal('Welcome user');
  });

  it('welcome3/test', async () => {
    const resp = await db.rewrite('test/welcome3/test', {method: 'PUT'});
    resp.code.should.equal(201);
    resp.body.should.equal('New World');
    resp.headers['Content-Type'].should.contain('charset=utf-8');

    const resp2 = await db.rewrite('test/welcome3/test');
    resp2.body.should.equal('Welcome test');
  });

  it('welcome4/user', async () => {
    const resp = await db.rewrite('test/welcome4/user');
    resp.body.should.equal('Welcome user');
  });

  it('welcome5/welcome3', async () => {
    const resp = await db.rewrite('test/welcome5/welcome3');
    resp.body.should.equal('Welcome welcome3');
  });

  it('basic view', async () => {
    const resp = await db.rewrite('test/basicView');
    resp.total_rows.should.equal(9);
  });

  it('root rewrite', async () => {
    const resp = await db.rewrite('test/');
    resp.total_rows.should.equal(9);
  });

  it('simple form basic view', async () => {
    const resp = await db.rewrite('test/simpleForm/basicView', {
      query: {startkey: 3, endkey: 8}
    });
    resp.code.should.equal(200);
    resp.body.should.not.contain('Key: 1');
    resp.body.should.contain('FirstKey: 3');
    resp.body.should.contain('LastKey: 8');
  });

  it('simple form basic view fixed', async () => {
    const resp = await db.rewrite('test/simpleForm/basicViewFixed');
    resp.code.should.equal(200);
    resp.body.should.not.contain('Key: 1');
    resp.body.should.contain('FirstKey: 3');
    resp.body.should.contain('LastKey: 8');
  });

  it('simple form basic view fixed different query', async () => {
    const resp = await db.rewrite('test/simpleForm/basicViewFixed', {
      query: {startkey: 4}
    });
    resp.code.should.equal(200);
    resp.body.should.not.contain('Key: 1');
    resp.body.should.contain('FirstKey: 3');
    resp.body.should.contain('LastKey: 8');
  });

  it('simple view basic view path', async () => {
    const resp = await db.rewrite('test/simpleForm/basicViewPath/3/8');
    resp.body.should.not.contain('Key: 1');
    resp.body.should.contain('FirstKey: 3');
    resp.body.should.contain('LastKey: 8');
  });

  it('simple form complex view', async () => {
    const resp = await db.rewrite('test/simpleForm/complexView');
    resp.code.should.equal(200);
    /FirstKey: [1, 2]/.test(resp.body).should.be.ok;
  });

  it('simple form complex view 2', async () => {
    const resp = await db.rewrite('test/simpleForm/complexView2');
    resp.code.should.equal(200);
    resp.body.should.contain('Value: doc 3');
  });

  it('simple form complex view 3', async () => {
    const resp = await db.rewrite('test/simpleForm/complexView3');
    resp.code.should.equal(200);
    resp.body.should.contain('Value: doc 4');
  });

  it('simple form complex view 4', async () => {
    const resp = await db.rewrite('test/simpleForm/complexView4');
    resp.code.should.equal(200);
    resp.body.should.contain('Value: doc 5');
  });

  it('simple form complex view 5 with args', async () => {
    const resp = await db.rewrite('test/simpleForm/complexView5/test/essai');
    resp.code.should.equal(200);
    resp.body.should.contain('Value: doc 4');
  });

  it('complex view 6 with query', async () => {
    const resp = await db.rewrite('test/simpleForm/complexView6',{
      query: {a: 'test', b: 'essai'}
    });
    resp.code.should.equal(200);
    resp.body.should.contain('Value: doc 4');
  });

  it('simple form complex view 7 with args and query', async () => {
    const resp = await db.rewrite('test/simpleForm/complexView7/test/essai', {
      query: {doc: true}
    });
    resp.rows[0].doc.should.be.an('object');
  });

  it('db with args', async () => {
    // The original test suite uses the 'meta' query parameter which PouchDB
    // doesn't implement. revs_info could just be dropped in without further
    // changes, though.
    const resp = await db.rewrite('test/db/_design/test', {query: {revs_info: true}});
    resp._id.should.equal('_design/test');
    resp._revs_info.should.be.instanceof(Array);
  });
});

describe('sync rewrite tests with invalid design doc', () => {
  beforeEach(() => {
    db = setup();
  });
  afterEach(teardown);

  it('empty design doc', async () => {
    await db.put({_id: '_design/test'});

    const err = await shouldThrowError(async () => {
      await db.rewrite('test/test/all');
    });
    err.status.should.equal(404);
    err.name.should.equal('rewrite_error');
    err.message.should.equal('Invalid path.');
  });

  it('invalid rewrites', async () => {
    await db.put({_id: '_design/test', rewrites: 'Hello World!'});

    const err = await shouldThrowError(async () => {
      await db.rewrite('test/test/all');
    });
    err.status.should.equal(400);
    err.name.should.equal('rewrite_error');
  });

  it('missing to', async () => {
    await db.put({_id: '_design/test', rewrites: [
      {from: '*'}
    ]});

    const err = await shouldThrowError(async () => {
      await db.rewrite('test/test/all');
    });

    err.status.should.equal(500);
    err.name.should.equal('error');
    err.message.should.equal('invalid_rewrite_target');
  });

  it('empty rewrites', async () => {
    await db.put({_id: '_design/test', rewrites: []});

    const err = await shouldThrowError(async () => {
      await db.rewrite('test/test/all');
    });
    err.status.should.equal(404);
    err.name.should.equal('not_found');
    err.message.should.equal('missing');
  });
});
