/**
 * @license Copyright (c) 2003-2021, CKSource - Frederico Knabben. All rights reserved.
 * For licensing, see LICENSE.md or https://ckeditor.com/legal/ckeditor-oss-license
 */

/**
 * @module content-compatibility/datafilter
 */

import { cloneDeep } from 'lodash-es';

import { Matcher } from 'ckeditor5/src/engine';
import { priorities, toArray } from 'ckeditor5/src/utils';

const DATA_SCHEMA_ATTRIBUTE_KEY = 'ghsAttributes';

/**
 * Allows to validate elements and element attributes registered by {@link module:content-compatibility/dataschema~DataSchema}.
 *
 * To enable registered element in the editor, use {@link #allowElement} method:
 *
 *		dataFilter.allowElement( {
 *			name: 'section'
 *		} );
 *
 * You can also allow or disallow specific element attributes:
 *
 *		// Allow `data-foo` attribute on `section` element.
 *		dataFilter.allowedAttributes( {
 *			name: 'section',
 *			attributes: {
 *				'data-foo': true
 *			}
 *		} );
 *
 *		// Disallow `color` style attribute on 'section' element.
 *		dataFilter.disallowedAttributes( {
 *			name: 'section',
 *			styles: {
 *				color: /[^]/
 *			}
 *		} );
 */
export default class DataFilter {
	constructor( editor, dataSchema ) {
		this.editor = editor;

		/**
		 * An instance of the {@link module:content-compatibility/dataschema~DataSchema}.
		 *
		 * @readonly
		 * @private
		 * @member {module:content-compatibility/dataschema~DataSchema} module:content-compatibility/datafilter~DataFilter#_dataSchema
		 */
		this._dataSchema = dataSchema;

		/**
		 * A map of registered {@link module:engine/view/matcher~Matcher Matcher} instances.
		 *
		 * Describes rules upon which content attributes should be allowed.
		 *
		 * @readonly
		 * @private
		 * @member {Map<string, module:engine/view/matcher~Matcher>} module:content-compatibility/datafilter~DataFilter#_allowedAttributes
		 */
		this._allowedAttributes = new Map();

		/**
		 * A map of registered {@link module:engine/view/matcher~Matcher Matcher} instances.
		 *
		 * Describes rules upon which content attributes should be disallowed.
		 *
		 * @readonly
		 * @private
		 * @member {Map<string, module:engine/view/matcher~Matcher>}
		 * module:content-compatibility/datafilter~DataFilter#_disallowedAttributes
		 */
		this._disallowedAttributes = new Map();
	}

	/**
	 * Allow the given element registered by {@link #register} method.
	 *
	 * @param {module:engine/view/matcher~MatcherPattern} config Pattern matching all view elements which should be allowed.
	 */
	allowElement( config ) {
		for ( const definition of this._dataSchema.getDefinitionsForView( config.name, true ) ) {
			this._registerElement( definition );
		}

		this.allowAttributes( config );
	}

	/**
	 * Allow the given attributes for view element allowed by {@link #allowElement} method.
	 *
	 * @param {module:engine/view/matcher~MatcherPattern} config Pattern matching all attributes which should be allowed.
	 */
	allowAttributes( config ) {
		this._addAttributeMatcher( config, this._allowedAttributes );
	}

	/**
	 * Disallowe the given attributes for view element allowed by {@link #allowElement} method.
	 *
	 * @param {module:engine/view/matcher~MatcherPattern} config Pattern matching all attributes which should be disallowed.
	 */
	disallowAttributes( config ) {
		this._addAttributeMatcher( config, this._disallowedAttributes );
	}

	/**
	 * Adds attribute matcher for every registered data schema definition for the given `config.name`.
	 *
	 * @private
	 * @param {module:engine/view/matcher~MatcherPattern} config
	 * @param {Map<string, module:engine/view/matcher~Matcher>} rules Rules map holding matchers.
	 */
	_addAttributeMatcher( config, rules ) {
		const viewName = config.name;

		config = cloneDeep( config );
		// We don't want match by name when matching attributes. Matcher will be already attached to specific definition.
		delete config.name;

		for ( const definition of this._dataSchema.getDefinitionsForView( viewName ) ) {
			getOrCreateMatcher( definition.view, rules ).add( config );
		}
	}

	/**
	 * @private
	 * @param {module:content-compatibility/dataschema~DataSchemaDefinition} definition
	 */
	_registerElement( definition ) {
		if ( this.editor.model.schema.isRegistered( definition.model ) ) {
			return;
		}

		this._defineSchema( definition );

		if ( definition.view ) {
			this._defineConverters( definition );
		}
	}

	/**
	 * @private
	 * @param {module:content-compatibility/dataschema~DataSchemaDefinition} definition
	 */
	_defineSchema( definition ) {
		const schema = this.editor.model.schema;

		schema.register( definition.model, definition.schema );

		const allowedChildren = toArray( definition.allowChildren || [] );

		for ( const child of allowedChildren ) {
			if ( schema.isRegistered( child ) ) {
				schema.extend( child, {
					allowIn: definition.model
				} );
			}
		}
	}

	/**
	 * @private
	 * @param {module:content-compatibility/dataschema~DataSchemaDefinition}
	 */
	_defineConverters( definition ) {
		const conversion = this.editor.conversion;
		const viewName = definition.view;
		const modelName = definition.model;

		// Consumes disallowed element attributes to prevent them of being processed by other converters.
		conversion.for( 'upcast' ).add( dispatcher => {
			dispatcher.on( `element:${ viewName }`, ( evt, data, conversionApi ) => {
				for ( const match of matchAll( data.viewItem, this._disallowedAttributes ) ) {
					conversionApi.consumable.consume( data.viewItem, match.match );
				}
			}, { priority: 'high' } );
		} );

		// Stash unused, allowed element attributes, so they can be reapplied later in data conversion.
		conversion.for( 'upcast' ).elementToElement( {
			view: viewName,
			model: ( viewElement, conversionApi ) => {
				const matches = [];
				for ( const match of matchAll( viewElement, this._allowedAttributes ) ) {
					if ( conversionApi.consumable.consume( viewElement, match.match ) ) {
						matches.push( match );
					}
				}

				const { attributes, styles, classes } = mergeMatchResults( matches );
				const viewAttributes = {};

				// Stash attributes.
				if ( attributes.size ) {
					viewAttributes.attributes = iterableToObject( attributes, key => viewElement.getAttribute( key ) );
				}

				// Stash styles.
				if ( styles.size ) {
					viewAttributes.styles = iterableToObject( styles, key => viewElement.getStyle( key ) );
				}

				// Stash classes.
				if ( classes.size ) {
					viewAttributes.classes = Array.from( classes );
				}

				const element = conversionApi.writer.createElement( modelName );

				if ( Object.keys( viewAttributes ).length ) {
					conversionApi.writer.setAttribute( DATA_SCHEMA_ATTRIBUTE_KEY, viewAttributes, element );
				}

				return element;
			},
			// With a `low` priority, `paragraph` plugin autoparagraphing mechanism is executed. Make sure
			// this listener is called before it. If not, some elements will be transformed into a paragraph.
			converterPriority: priorities.get( 'low' ) + 1
		} );

		conversion.for( 'downcast' ).elementToElement( {
			model: modelName,
			view: viewName
		} );

		conversion.for( 'downcast' ).add( dispatcher => {
			dispatcher.on( `attribute:${ DATA_SCHEMA_ATTRIBUTE_KEY }:${ modelName }`, ( evt, data, conversionApi ) => {
				const viewAttributes = data.attributeNewValue;

				if ( viewAttributes === null ) {
					return;
				}

				if ( !conversionApi.consumable.consume( data.item, evt.name ) ) {
					return;
				}

				const viewWriter = conversionApi.writer;
				const viewElement = conversionApi.mapper.toViewElement( data.item );

				if ( viewAttributes.attributes ) {
					for ( const [ key, value ] of Object.entries( viewAttributes.attributes ) ) {
						viewWriter.setAttribute( key, value, viewElement );
					}
				}

				if ( viewAttributes.styles ) {
					viewWriter.setStyle( viewAttributes.styles, viewElement );
				}

				if ( viewAttributes.classes ) {
					viewWriter.addClass( viewAttributes.classes, viewElement );
				}
			} );
		} );
	}
}

/**
 * Helper function restoring matcher for the given key from `rules` object.
 *
 * If matcher for the given key does not exist, this function will create a new one
 * inside `rules` object under the given key.
 *
 * @private
 * @param {String} key
 * @param {Map} rules
 */
function getOrCreateMatcher( key, rules ) {
	if ( !rules.has( key ) ) {
		rules.set( key, new Matcher() );
	}

	return rules.get( key );
}

/**
 * Alias for {@link module:engine/view/matcher~Matcher#matchAll matchAll}.
 *
 * @private
 * @param {module:engine/view/element~Element} viewElement
 * @param {Map} rules Rules map holding matchers.
 * @returns {Object} result
 * @returns {Array} result.attributes Array with matched attribute names.
 * @returns {Array} result.classes Array with matched class names.
 * @returns {Array} result.styles Array with matched style names.
 */
function matchAll( viewElement, rules ) {
	const matcher = getOrCreateMatcher( viewElement.name, rules );

	return matcher.matchAll( viewElement ) || [];
}

/**
 * Merges the result of {@link module:engine/view/matcher~Matcher#matchAll} method.
 *
 * @private
 * @param {Array} matches
 * @returns {Object} result
 * @returns {Array} result.attributes Array with matched attribute names.
 * @returns {Array} result.classes Array with matched class names.
 * @returns {Array} result.styles Array with matched style names.
 */
function mergeMatchResults( matches ) {
	const matchResult = {
		attributes: new Set(),
		classes: new Set(),
		styles: new Set()
	};

	for ( const match of matches ) {
		for ( const key in matchResult ) {
			const values = match.match[ key ] || [];
			values.forEach( value => matchResult[ key ].add( value ) );
		}
	}

	return matchResult;
}

/**
 * Convertes the given iterable object into an object.
 *
 * @private
 * @param {Iterable<String>} iterable
 * @param {Function} getValue Shoud result with value for the given object key.
 * @returns {Object}
 */
function iterableToObject( iterable, getValue ) {
	const attributesObject = {};

	for ( const prop of iterable ) {
		attributesObject[ prop ] = getValue( prop );
	}

	return attributesObject;
}
