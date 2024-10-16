/* 
TODO:
. sort results
. show the correct label for the script
. remove all hard-coded values
*/

import { utils, DEBUG_DONT_SAVE, IS_BROWSER_LOCAL} from "../utils.mjs";
import { AnyFileSystem } from "../any-file-system.mjs";
import { createApp, nextTick } from "vue";
import { AvailableTags } from "../tags.mjs";

const INDEX_PATH = 'app/index.json'
const ITEMS_PER_PAGE = 24
const OPTIONS_PER_FACET = 15
const OPTIONS_PER_FACET_EXPANDED = 100
const HIDE_OPTIONS_WITH_ZERO_COUNT = true
const CHANGE_QUEUE_PATH = 'annotations/change-queue.json'
const TAG_EXEMPLAR = 'm.exemplar'
const VARIANT_RULES_PATH = 'app/data/variant-rules.json'
const SHA_UNREAD = 'SHA_UNREAD'

createApp({
  data() {
    return {
      selection: {
        tab: 'search',
        showSuppliedText: false,
        gtoken: window.localStorage.getItem('gtoken') || '',
        // TODO: remove partial duplication with /annotation
        annotationId: '',
        object: null, // ?
        image: null, // ?
        searchPhrase: '',
        facets: {},
        page: 1,
        perPage: ITEMS_PER_PAGE,
        // facetName: {sort: key|count, order: asc|desc, size: N}
        facetsSettings: JSON.parse(window.localStorage.getItem('facetsSettings') || '{}'),
        items: new Set(),
        newTagName: '',
        newTypeName: '',
      },
      // instance of AnyFileSystem, to access github resources
      afs: null,
      changeQueue: {
        changes: [],
      },
      // the github sha of the annotations file.
      // needed for writing it and detecting conflicts.
      changeQueueSha: SHA_UNREAD,
      // ---
      variantRules: [],
      variantRulesSha: SHA_UNREAD,
      // ---
      options: {
        perPage: [12, 24, 50, 100]
      },
      // See itemsjs.search()
      results: {
        pagination: {},
        data: {
          items: [],
          aggregations: {},
        }
      },
      messages: [
      ],
      cache: {
      },
      user: null,
      definitions: {
        tags: {
        }
      },
      availableTags: new AvailableTags(),
      hoveredItem: null,
      showModalOnTheRight: false,
      indexDate: null,
    }
  },
  async mounted() {
    await this.availableTags.load()

    await this.initAnyFileSystem()
    
    await this.loadVariantRules()
    await this.loadChangeQueue()
    await this.loadIndex()

    // not before
    for (let tag of this.availableTags.tags) {
      this.definitions.tags[tag] = null
    }

    this.setSelectionFromAddressBar()
    this.search(true)
  },
  watch: {
    'selection.searchPhrase'() {
      this.selection.facets = {}
      this.search()
    },
    'selection.perPage'() {
      // console.log('selection.perPage')
      this.search()
    }
  },
  computed: {
    tabs: () => utils.tabs(),
    items() {
      return this.results?.data?.items
    },
    pagination() {
      return this.results?.pagination || {
        page: 1,
        per_page: this.selection.perPage,
        total: 0
      }
    },
    tagSelection() {
      let ret = ''
      let stats = [0, 0]

      for (let state of Object.values(this.definitions.tags)) {
        if (state === false) stats[1]++;
        if (state === true) stats[0]++;
      }

      if (stats[0]) {
        ret += `+${stats[0]}`
      }
      if (stats[1]) {
        if (ret) ret += ', ';
        ret += `-${stats[1]}`
      }

      if (ret) {
        ret = `(${ret})`
      }

      return ret
    },
    lastMessage() {
      let ret = {
        content: '',
        level: 'info',
        created: new Date()
      }
      if (this.messages.length) {
        ret = this.messages[this.messages.length - 1]
      }
      return ret
    },
    facets() {
      // chr: 
      //   buckets
      //     - doc_count: 3
      //       key: "A"
      //       selected: false
      return this.results?.data?.aggregations
    },
    pageMax() {
      let ret = 1
      let pagination = this?.results?.pagination
      if (pagination) {
        ret = Math.ceil(pagination.total / pagination.per_page)
      }
      return ret
    },
    canEdit() {
      return this.isLoggedIn
    },
    isLoggedIn() {
      return this.afs?.isAuthenticated()
    },
    isUnsaved() {
      return this.selection.items.size && Object.values(this.definitions.tags).filter(t => t !== null).length
    },
    tagFormatError() {
      return this.availableTags.getTagFormatError(this.selection.newTagName, this.availableTags.tags)
    },
    typeFormatError() {
      // TODO: check for rule duplication
      let ret = this.availableTags.getTagFormatError(this.selection.newTypeName, [])
      if (!ret && this.selection.newTypeName) {
        let selectedAllographs = this.selection.facets?.chr || []
        let selectedComponentFeatures = this.selection.facets?.cxf || []
        if (selectedAllographs.length !== 1 || selectedComponentFeatures.length < 1) {
          ret = 'Please select one Allograph and at least a Component x Feature in the above filters.'
        }
      }
      return ret
    }
  },
  methods: {
    async initAnyFileSystem() {
      this.afs = new AnyFileSystem()
      await this.afs.authenticateToGithub(this.selection.gtoken)
    },
    async loadIndex() {
      // fetch with API so we don't need to republish site each time the index is rebuilt.
      this.index = null
      if (IS_BROWSER_LOCAL) {  
        this.index = await utils.fetchJsonFile('index.json')
      } else {
        let res = await this.afs.readJson(INDEX_PATH)
        if (res.ok) {
          this.index = res.data
        }
      }
      if (!this.index?.data) {
        this.logMessage(`Failed to load search index from github (${res.description})`, 'error')
        this.index = {
          meta: {
            "dc:modified": "2000-01-01T01:01:01.042Z",
          },
          data: []
        }
      }
      this.indexDate = new Date(this.index.meta['dc:modified'])

      // order field
      this.annotationIdsToItem = {}
      for (let item of this.index.data) {
        // TODO: reduce id in the key
        this.annotationIdsToItem[item.id] = item
        // reduce item.img
        item.or1 = `${item.img}-${item.scr}-${item.chr}`
        item.docId = this.getDocIdFromItem(item)
      }

      this.applyChangeQueueToIndex()

      this.resetItemsjsconfig()

      window.addEventListener('resize', this.loadVisibleThumbs);
      window.addEventListener('scroll', this.loadVisibleThumbs);
    },
    async loadChangeQueue() {
      let res = await this.afs.readJson(CHANGE_QUEUE_PATH)
      if (res && res.ok) {
        this.changeQueue = res.data
        this.changeQueueSha = res.sha
        this.changeQueue.changes = this.changeQueue?.changes || []
      } else {
        this.logMessage(`Failed to load change queue from github (${res.description})`, 'error')
      }
    },
    async loadVariantRules() {
      let res = await this.afs.readJson(VARIANT_RULES_PATH)
      if (res && res.ok) {
        this.variantRules = res.data
        this.variantRulesSha = res.sha
      } else {
        this.variantRules = []
        this.logMessage(`Failed to load variant rules from github (${res.description})`, 'error')
      }
    },
    applyChangeQueueToIndex() {
      for (let change of this.changeQueue?.changes) {
        this.applyChangeToIndex(change)
      }
    },
    applyChangeToIndex(change) {
      for (let ann of change.annotations) {
        let item = this.annotationIdsToItem[ann.id]
        if (item) {
          // remove code duplication with reun-change-queue.mjs
          let tagsSet = new Set(item.tag || [])
          for (let tag of change.tags) {
            if (tag.startsWith('-')) {
              tagsSet.delete(tag.substring(1))
            } else {
              tagsSet.add(tag)
              this.availableTags.addTag(tag)
            }
          }    
          item.tag = [...tagsSet]
        }
      }
    },
    getAnnotationFileNameFromItem(item) {
      // TODO: filename should be in the search index 
      // instead of hardcoding the reconstruction here.
      // But that would inflate its size.
      //
      // returns:
      // 'http-sicily-classics-ox-ac-uk-inscription-isic020930-isic020930-jpg.json'
      // from: 
      // item.doc = 'http://sicily.classics.ox.ac.uk/inscription/ISic000085.xml'
      // item.img = 'https://apheleia.classics.ox.ac.uk/iipsrv/iipsrv.fcgi?IIIF=/inscription_images/ISic000085/ISic000085_tiled.tif'

      let ret = ''

      ret = item.doc.replace('.xml', '')
      ret += item.img.replace(/^.*(\/[^/]+)_tiled\.tif$/, '$1.jpg')
      ret = utils.slugify(ret)
      ret += '.json'

      return ret
    },
    async saveChangeQueue() {
      let ret = false
      if (DEBUG_DONT_SAVE) {
        console.log('WARNING: DEBUG_DONT_SAVE = True => skip saving.')
        ret = true
      } else {
        if (this.isUnsaved) {
          let change = {
            // annotationIds: [...this.selection.items].map(item => item.id),
            annotations: [...this.selection.items].map(item => ({'id': item.id, 'file': this.getAnnotationFileNameFromItem(item)})),
            // e.g. tags: ['tag1', -tag3', 'tag10']
            tags: Object.entries(this.definitions.tags).filter(kv => kv[1] !== null).map(kv => (kv[1] === false ? '-' : '') + kv[0]),
            creator: this.afs.getUserId(),
            created: new Date().toISOString(),
          }
          this.changeQueue.changes.push(change)
          let res = await this.afs.writeJson(CHANGE_QUEUE_PATH, this.changeQueue, this.changeQueueSha)
          if (res && res.ok) {
            ret = true
            this.changeQueueSha = res.sha;
          }
          this.applyChangeToIndex(change)
          // TODO: error management
        }
      }
      if (ret) {
        this.selection.items.clear()
      }
      return ret
    },
    resetSearch() {
      this.selection.searchPhrase = ''
      this.selection.facets = {}
      this.search()
    },
    resetItemsjsconfig() {
      let config = {
        sortings: {
          or1: {
            field: 'or1',
            order: 'asc'
          }
        },
        aggregations: this.getFacetDefinitions(),
        searchableFields: ['tag', 'docId']
      }
      this.itemsjs = window.itemsjs(this.index.data, config);
    },
    onClickFacetExpand(facetKey) {
      let settings = this.getFacetSettings(facetKey)
      settings.size = settings.size == OPTIONS_PER_FACET ? OPTIONS_PER_FACET_EXPANDED : OPTIONS_PER_FACET;
      this.setFacetSettings(facetKey, settings)
    },
    getFacetSettings(facetKey) {
      let ret = this.selection.facetsSettings[facetKey] || {
        size: OPTIONS_PER_FACET,
        sort: 'count',
        order: 'desc',
      };
      return ret
    },
    isFacetExpanded(facetKey) {
      let settings = this.getFacetSettings(facetKey)
      return settings.size != OPTIONS_PER_FACET 
    },
    isFacetSortedBy(facetKey, sort, order) {
      let settings = this.getFacetSettings(facetKey)
      return settings.sort == sort && settings.order == order
      
    },
    onClickFacetColumn(facetKey, columnName) {
      let settings = this.getFacetSettings(facetKey)
      if (settings.sort == columnName) {
        settings.order = settings.order == 'asc' ? 'desc' : 'asc'
      } else {
        settings.sort = settings.sort == 'count' ? 'key' : 'count'
        settings.order = settings.sort == 'count' ? 'desc' : 'asc'
      }
      this.setFacetSettings(facetKey, settings)
    },
    setFacetSettings(facetKey, settings) {
      this.selection.facetsSettings[facetKey] = settings;
      window.localStorage.setItem('facetsSettings', JSON.stringify(this.selection.facetsSettings));
      this.resetItemsjsconfig()
      this.search()
    },
    getFacetDefinitions() {
      let ret = {
        scr: {
          title: 'Script',
        },
        chr: {
          title: 'Allograph',
        },
        tag: {
          title: 'Tags',
        },
        com: {
          title: 'Components',
        },
        fea: {
          title: 'Features',
        },
        cxf: {
          title: 'Component x Features',
          // gh-56
          sort: 'key'
        },
      }
      for (let facetKey of Object.keys(ret)) {
        let facet = ret[facetKey]
        let settings = this.getFacetSettings(facetKey)
        facet.size = settings.size
        facet.sort = settings.sort
        facet.order = settings.order
        facet.hide_zero_doc_count = HIDE_OPTIONS_WITH_ZERO_COUNT
      }
      return ret
    },
    search(keepPage=false) {
      // .pagination
      // data.items
      // data.aggregations
      if (!keepPage) {
        this.selection.page = 1
      }
      this.results = this.itemsjs.search({
        per_page: this.selection.perPage,
        page: this.selection.page,
        sort: 'or1',
        query: this.selection.searchPhrase,
        filters: this.selection.facets
      })
      // img.addEventListener('load', loaded)
      this.$nextTick(() => {
        this.loadVisibleThumbs()
        // this.loadLazyThumbs()
      })
      this.setAddressBarFromSelection()
    },
    loadVisibleThumbs() {
      for (let element of document.querySelectorAll('.graph-thumb')) {
        let dataSrc = element.attributes['data-src']
        if (dataSrc) {
          let distanceFromBottom = window.innerHeight - element.getBoundingClientRect().top
          let distanceFromTop = element.getBoundingClientRect().bottom
          let distanceFromEdge = Math.min(distanceFromBottom, distanceFromTop)
          // console.log(distanceFromBottom)
          // element.setAttribute('data-dist', distanceFromBottom)
          if (distanceFromEdge > -200) {
            element.classList.add('thumb-loading')
            element.src = dataSrc.value
            element.removeAttribute('data-src')
            element.addEventListener('load', (event) => {
              element.classList.remove('thumb-loading')
            })  
          }
        }
      }
    },
    getThumbUrlFromTag(tag, height=40) {
      let item = null

      return this.getThumbUrlFromItem(item, height=height)
    },
    getThumbUrlFromItem(item, height=48) {
      let ret = ''
      if (item) {
        let crop = item.box.substring(11)
        ret = `${item.img}/${crop}/,${height}/0/default.jpg`
      }

      return ret
    },
    placeholderThumb(item) {
      // data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=
      return 'data:image/svg+xml;UTF8,<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect x="0" y="0" rx="2" ry="2" width="48" height="48" style="fill:lightgrey;stroke:grey;stroke-width:2;opacity:1" /></svg>'
    },
    getThumbClass(item) {
      return 'unloaded-thumb'
    },
    getDocIdFromItem(item) {
      // TODO get from doc when doc will be always populated
      // let ret = (item?.doc || '').replace(/^.*id=/, '')
      let ret = (item?.img || '').replace(/^.*inscription_images\/([^/]+)\/.*$/, '$1')
      return ret
    },
    getAnnotatorLinkFromItem(item) {
      // TODO: remove hard-coded assumptions.
      // the transforms (obj, img) should be more dynamic than that.
      let ret = ''
      let annotatorImageId = item.img.replace('_tiled.tif', `.jpg`).replace(/^.*\//, '')
      ret = `./annotator.html?obj=http://sicily.classics.ox.ac.uk/inscription/${this.getDocIdFromItem(item)}&img=${annotatorImageId}&ann=${item.id}`
      return ret
    },
    getOptionsFromFacet(facet) {
      let ret = facet.buckets.filter(o => {
        return o.key != 'null'
      })
      return ret
    },
    onClickFacetOption(facetKey, optionKey) {
      let facet = this.selection.facets[facetKey]
      if (!facet) {
        facet = this.selection.facets[facetKey] = []
      } else {
        if (facet.includes(optionKey)) {
          if (facet.length == 1) {
            delete this.selection.facets[facetKey]
          } else {
            this.selection.facets[facetKey] = facet.filter(
              o => o != optionKey
            )
          }
          facet = null
        }
      }
      if (facet) {
        facet.push(optionKey)
      }
      this.search()
    },
    onClickPagination(step) {
      let page = this.selection.page + step
      if (page < 1) page = 1;
      if (page > this.pageMax) page = this.pageMax;
      if (this.selection.page != page) {
        this.selection.page = page
        this.search(true)
      }
    },
    // preview annotation
    onMouseEnterItem(item) {
      this.hoveredItem = item
      this.showModalOnTheRight = false
    },
    onMouseLeaveItem(item) {
      this.hoveredItem = null
    },
    // preview tag examplar
    onMouseEnterTag(tag, showModalOnTheRight=false) {
      // TODO: cache the results for each tag
      let ret = null
      let selectedAllographs = this.selection.facets?.chr || []
      if (selectedAllographs.length == 1) {
        ret = this._searchByTag(tag, selectedAllographs[0], true) || this._searchByTag(tag, selectedAllographs[0])
      }
      ret = ret || this._searchByTag(tag, null, true) || this._searchByTag(tag)
      this.hoveredItem = ret
      this.showModalOnTheRight = showModalOnTheRight
    },
    _searchByTag(tag, allograph=null, exemplar=false) {
      let filters = {
        'tag': [tag]
      }
      if (exemplar) filters.tag.push(TAG_EXEMPLAR);
      if (allograph) filters.chr = [allograph]
      let res = this.itemsjs.search({
        per_page: 1,
        page: 1,
        sort: 'or1',
        query: '',
        filters: filters
      })
      let items = res?.data?.items
      let ret = items ? items[0] : null
      // console.log(tags, items.length)
      return ret
    },
    onMouseLeaveTag(tag) {
      this.hoveredItem = null
    },
    // ----------------------
    // bulk-edit
    onClickItem(item) {
      if (this.selection.items.has(item)) {
        this.selection.items.delete(item)
      } else {
        this.selection.items.add(item)
      }
    },
    onAddTag() {
      if (this.tagFormatError) return;
      let tag = this.availableTags.addTag(this.selection.newTagName);
      if (!tag) return;
      this.definitions.tags[this.selection.newTagName] = null
      this.selection.newTagName = ''
    },
    onClickTag(tag) {
      let stateTransitions = {true: false, false: null, null: true}
      this.definitions.tags[tag] = stateTransitions[this.definitions.tags[tag]]
    },
    // -----------------------
    async onAddType() {
      if (this.typeFormatError) return;
      let variantRule = {
        'variant-name': this.selection.newTypeName,
        allograph: this.selection.facets.chr[0],
        // ["crossbar is ascending", "crossbar is straight" ] 
        // -> [{component: 'crossbar', feature: 'ascending'}, ...]
        'component-features': this.selection.facets.cxf.map((cxf) => {
          let parts = cxf.split(' is ')
          return {
            component: parts[0],
            feature: parts[1],
          }
        }),
      }
      // TODO: is the allograph enough? We might need the script to disambiguate
      this.variantRules.push(variantRule)
      let res = await this.afs.writeJson(VARIANT_RULES_PATH, this.variantRules, this.variantRulesSha)
      if (res && res.ok) {
        this.variantRulesSha = res.sha
        this.selection.newTypeName = ''
      } else {
        this.logMessage(`Failed to save new variant rule. You might have to reload the page and try again.`, 'error')
      }
      // this.afs.writeJson()
      // let tag = this.availableTags.addTag(this.selection.newTagName);
      // if (!tag) return;
      // this.definitions.tags[this.selection.newTagName] = null
      // this.selection.newTagName = ''
    },
    // -----------------------
    logMessage(content, level = 'info') {
      // level: info|primary|success|warning|danger
      this.messages.push({
        content: content,
        level: level,
        created: new Date()
      })
    },
    getQueryString() {
      return utils.getQueryString()
    },
    setAddressBarFromSelection() {
      // ?object
      // let searchParams = new URLSearchParams(window.location.search)
      let searchParams = {
        obj: this.selection.object,
        img: this.selection.image,
        sup: this.selection.showSuppliedText ? 1 : 0,
        ann: (this.annotation?.id || '').replace(/^#/, ''),
        // scr: this.description.script,

        q: this.selection.searchPhrase,
        pag: this.selection.page,
        ppg: this.selection.perPage,
      };

      for (let facet of Object.keys(this.selection.facets)) {
        searchParams[`f.${facet}`] = this.selection.facets[facet].join('|')
      }
      utils.setQueryString(searchParams)
    },
    setSelectionFromAddressBar() {
      let searchParams = new URLSearchParams(window.location.search);

      this.selection.object = searchParams.get('obj') || ''
      this.selection.image = searchParams.get('img') || ''
      this.selection.showSuppliedText = searchParams.get('sup') === '1'
      this.selection.annotationId = searchParams.get('ann') || ''
      // this.description.script = searchParams.get('scr') || ''

      this.selection.searchPhrase = searchParams.get('q') || ''
      if (!this.selection.searchPhrase && this.selection.image) {
        this.selection.searchPhrase = this.selection.image.replace(/\.[^.]+$/, '')
      }
      this.selection.page = parseInt(searchParams.get('pag') || '1')
      this.selection.perPage = parseInt(searchParams.get('ppg') || ITEMS_PER_PAGE)

      for (let facet of Object.keys(this.getFacetDefinitions())) {
        let options = searchParams.get(`f.${facet}`)
        if (options) {
          this.selection.facets[facet] = options.split('|')
        }
      }
    },
  }
}).mount('#search');
