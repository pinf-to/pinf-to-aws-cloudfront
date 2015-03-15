
// TODO: Rename to `pinf-bundle`.

const AWS = require("aws-sdk");
const S3 = require("s3");
const URL = require("url");
const CRYPTO = require("crypto");


require("to.pinf.lib/lib/publish").for(module, function (API, callback) {

	API.ASSERT.equal(typeof process.env.AWS_ACCESS_KEY, "string", "'AWS_ACCESS_KEY' variable must be set!");
	API.ASSERT.equal(typeof process.env.AWS_SECRET_KEY, "string", "'AWS_SECRET_KEY' variable must be set!");

	var s3low = new AWS.S3(new AWS.Config({
		accessKeyId: process.env.AWS_ACCESS_KEY,
		secretAccessKey: process.env.AWS_SECRET_KEY,
		apiVersion: '2006-03-01'
	}));

	var s3high = S3.createClient({
	  	s3Client: s3low
	});

	var cloudfront = new AWS.CloudFront(new AWS.Config({
		accessKeyId: process.env.AWS_ACCESS_KEY,
		secretAccessKey: process.env.AWS_SECRET_KEY,
		apiVersion: '2014-11-06'
	}));

	return API.getPrograms(function (err, programs) {
		if (err) return callback(err);

		var waitfor = API.WAITFOR.serial(callback);
		
		for (var programDescriptorPath in programs) {
			waitfor(programDescriptorPath, function (programDescriptorPath, callback) {

				try {

					programDescriptor = programs[programDescriptorPath];

					API.ASSERT.equal(typeof programDescriptor.combined.name, "string", "name' must be set in '" + programDescriptorPath + "'");

					var programName = programDescriptor.combined.name.toLowerCase();

					console.log("Publish program (" + programName + "):", programDescriptorPath);

					var config = API.getConfigFrom(programDescriptor.combined, "github.com/pinf-to/pinf-to-aws-cloudfront/0");

					var sourcePath = API.PATH.dirname(programDescriptorPath);
					var pubPath = API.PATH.join(programDescriptorPath, "../.pub");

					var templatePath = API.PATH.join(__dirname, "../template");
					var templateDescriptorPath = API.PATH.join(templatePath, "package.json");
					var templateDescriptor = API.FS.readJsonSync(templateDescriptorPath);

					API.ASSERT.equal(typeof templateDescriptor.directories.deploy, "string", "'directories.deploy' must be set in '" + templateDescriptorPath + "'");

					var relativeBaseUri = "";

					function copy (fromPath, toPath, callback) {

						console.log("Copying and transforming fileset", fromPath, "to", toPath, "...");

						var domain = require('domain').create();
						domain.on('error', function(err) {
							// The error won't crash the process, but what it does is worse!
							// Though we've prevented abrupt process restarting, we are leaking
							// resources like crazy if this ever happens.
							// This is no better than process.on('uncaughtException')!
							console.error("UNHANDLED DOMAIN ERROR:", err.stack, new Error().stack);
							process.exit(1);
						});
						domain.run(function() {

							try {

								var isDirectory = API.FS.statSync(fromPath).isDirectory();

								var destinationStream = null;

								if (isDirectory) {
									destinationStream = API.GULP.dest(toPath);
								} else {
									destinationStream = API.GULP.dest(API.PATH.dirname(toPath));
								}

								destinationStream.once("error", function (err) {
									return callback(err);
								});

								destinationStream.once("end", function () {

									console.log("... done");

									return callback();
								});

								var filter = API.GULP_FILTER([
									'index.html',
									'**/index.html'
								]);

								// TODO: Respect gitignore by making pinf walker into gulp plugin. Use pinf-package-insight to load ignore rules.
								var stream = null;
								if (isDirectory) {
									stream = API.GULP.src([
										"**",
										"!.pub/",
										"!.pub/**",
										"!npm-debug.log",
										"!node_modules/",
										"!node_modules/**"
									], {
										cwd: fromPath
									});
								} else {
									stream = API.GULP.src([
										API.PATH.basename(fromPath)
									], {
										cwd: API.PATH.dirname(fromPath)
									});											
								}

								stream
									.pipe(API.GULP_PLUMBER())
									.pipe(API.GULP_DEBUG({
										title: '[pinf-to-docker]',
										minimal: true
									}))
									.pipe(filter)
									// TODO: Add generic variables here and move to `to.pinf.lib`.
									.pipe(API.GULP_REPLACE(/%[^%]+%/g, function (matched) {
										// TODO: Arrive at minimal set of core variables and options to add own.
										if (matched === "%boot.loader.uri%") {
											return (relativeBaseUri?relativeBaseUri+"/":"") + "bundles/loader.js";
										} else
										if (matched === "%boot.bundle.uri%") {
											return (relativeBaseUri?relativeBaseUri+"/":"") + ("bundles/" + programDescriptor.combined.packages[programDescriptor.combined.boot.package].combined.exports.main).replace(/\/\.\//, "/");
										}
										return matched;
									}))
									.pipe(filter.restore())											
									.pipe(destinationStream);

								return stream.once("error", function (err) {
									err.message += " (while running gulp)";
									err.stack += "\n(while running gulp)";
									return callback(err);
								});
							} catch (err) {
								return callback(err);
							}
						});
					}

					function copyFiles (fromPath, toPath, callback) {

						console.log("Copying and transforming program from", fromPath, "to", toPath, "using config", config);

						return API.FS.remove(toPath, function (err) {
							if (err) return callback(err);

							return copy(API.PATH.join(templatePath), toPath, function (err) {
								if (err) return callback(err);

								return copy(fromPath, API.PATH.join(toPath, templateDescriptor.directories.deploy), callback);
							});
						});
					}

					function writeLoader (callback) {

						var toPath = API.PATH.join(pubPath, templateDescriptor.directories.deploy, "loader.js");

						console.log("Copying loader to '" + toPath + "'");

						return API.FS.copy(
							API.PATH.join(__dirname, "../node_modules/to.pinf.lib/node_modules/pinf-loader-js/loader.js"),
							toPath,
							callback
						);
					}

					function copyCustomTemplates (callback) {
						if (!config.templates) return callback(null);
						var waitfor = API.WAITFOR.serial(callback);
						for (var uri in config.templates) {
							waitfor(uri, function (uri, callback) {
								return copy(
									API.PATH.join(fromPath, config.templates[uri]),
									API.PATH.join(pubPath, uri),
									callback
								);
							});
						}
						return waitfor();
					}

					var packageDescriptor = programDescriptor.combined.packages[programDescriptor.combined.boot.package].combined;

					function writeProgramDescriptor (callback) {

						var pubProgramDescriptorPath = API.PATH.join(pubPath, "program.json");

						// TODO: Use PINF config tooling to transform program descriptor from one context to another.

						var bundles = {};

						if (
							packageDescriptor.exports &&
							packageDescriptor.exports.bundles
						) {
							for (var bundleUri in packageDescriptor.exports.bundles) {
								bundles[bundleUri] = {
									"source": {
										"path": API.PATH.relative(API.PATH.dirname(pubProgramDescriptorPath), programDescriptorPath),
										"overlay": {
											"layout": {
												"directories": {
											        "bundles": API.PATH.relative(API.PATH.dirname(programDescriptorPath), API.PATH.join(pubPath, templateDescriptor.directories.deploy))
											    }
										    }
										}
									},
									"path": "./" + API.PATH.join(templateDescriptor.directories.deploy, packageDescriptor.exports.bundles[bundleUri])
								};
							}
						}

						var descriptor = {};

						// TODO: Add more program properties needed to seed the runtime system.

						if (Object.keys(bundles).length > 0) {
							descriptor.exports = {
								"bundles": bundles
							};
						}

						console.log(("Writing program descriptor to: " + pubProgramDescriptorPath).yellow);
						return API.FS.writeFile(pubProgramDescriptorPath, JSON.stringify(descriptor, null, 4), callback);
					}

					function ensureUploaded (callback) {

						var bucketName = programName;
						var uploadedPaths = [];

						console.log("Ensure uploaded to S3 bucket '" + bucketName + "'");

						// TODO: Download manifest to see what has changed.
						//       If no manifest, list files to see if changed

						function ensureBucket (_callback) {

							function callback (err) {
								if (err) return _callback(err);
								return _callback(null, URL.parse(S3.getPublicUrlHttp(bucketName, "")).hostname);
							}

							return s3low.listBuckets({}, function (err, _buckets) {
								if (err) return callback(err);

								var found = false;
								if (_buckets.Buckets) {
									_buckets.Buckets.forEach(function (bucket) {
										if (found) return; // TODO: exit foreach
										if (bucket.Name === bucketName) {
											found = true;
										}
									});
								}

								function ensureAccessPolicy (callback) {
									console.log("Ensuring public access policy for bucket '" + bucketName + "'")
									return s3low.getBucketPolicy({
										Bucket: bucketName
									}, function(err, data) {
										if (err) {
											if (err.statusCode === 404) {
												return s3low.putBucketPolicy({
													Bucket: bucketName,
													// @see https://ariejan.net/2010/12/24/public-readable-amazon-s3-bucket-policy/
													Policy: JSON.stringify({
													  "Version":"2008-10-17",
													  "Statement":[
													    {
													      "Sid": "AllowPublicRead",
													      "Effect": "Allow",
													      "Principal": {
													        "AWS": "*"
													      },
													      "Action": [
													        "s3:GetObject"
													      ],
													      "Resource":[
													        "arn:aws:s3:::" + bucketName + "/*"
													      ]
													    }
													  ]
													})
												}, function(err, data) {
													if (err) return callback(err);

												console.log("PUT PPOLIY", data);

													return callback(null);
												});
											}
											return callback(err);
										}
										return callback();
									});									
								}

								if (found) {
									return ensureAccessPolicy(callback);
								}

								console.log("Creating bucket '" + bucketName + "'")

								function create (callback) {
									return s3low.createBucket({
										Bucket: bucketName,
										ACL: "public-read"
									}, callback);
								}

								return create(function (err) {
									if (err) return callback(err);

									return ensureAccessPolicy(callback);
								});
							});
						}

						function upload (callback) {
							var uploader = s3high.uploadDir({
								localDir: pubPath,
								deleteRemoved: false,
								s3Params: {
									Bucket: bucketName,
									Prefix: "",
									ACL: 'public-read'
									// See: http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html#putObject-property 
								},
							});
					        uploader.on('fileUploadStart', function (fullPath, fullKey) {
					        	uploadedPaths.push(fullKey);
					        });

							uploader.on("error", callback);
							uploader.on("progress", function () {
								console.log("progress", uploader.progressAmount, uploader.progressTotal);
							});
							return uploader.on('end', callback);
						}

						return ensureBucket(function (err, s3BucketHost) {
							if (err) return callback(err);

							return upload(function (err) {
								if (err) return callback(err);

								return callback(null, s3BucketHost, uploadedPaths);
							});
						});
					}

					function ensureDistribution (s3BucketHost, uploadedPaths, callback) {

						function repeat (callback) {
							console.log("Waiting 30 seconds before checking status of distribution ...");
							return setTimeout(function () {
								return ensureDistribution(s3BucketHost, uploadedPaths, callback);
							}, 30 * 1000);
						}

						var config = {
						  DistributionConfig: {
						  	// TODO: Generate a better hash
						    CallerReference: null,
						    Comment: null,
						    DefaultCacheBehavior: {
						      ForwardedValues: {
						        Cookies: {
						          Forward: 'none'
						        },
						        QueryString: false,
						        Headers: {
						          Quantity: 0
						        }
						      },
						      MinTTL: 60 * 60,  // 1 hour
						      TargetOriginId: s3BucketHost,
						      TrustedSigners: {
						        Enabled: false,
						        Quantity: 0
						      },
						      ViewerProtocolPolicy: 'allow-all'
						    },
						    Enabled: true,
						    Origins: {
						      Quantity: 1,
						      Items: [
						        {
						          DomainName: s3BucketHost,
						          Id: s3BucketHost,
						          OriginPath: '',
						          S3OriginConfig: {
						            OriginAccessIdentity: ""
						          }
						        },
						      ]
						    },
						    DefaultRootObject: "index.html"
						  }
						};

						var distributionId = programName + "-" + CRYPTO.createHash("md5").update(JSON.stringify(config)).digest('hex');

						config.DistributionConfig.CallerReference = distributionId;
						config.DistributionConfig.Comment = distributionId;

						console.log("Ensure cloud front distribution '" + distributionId + "' exists");

						return cloudfront.listDistributions({}, function (err, _existingDistributions) {
							if (err) return callback(err);

							var found = false;

							if (
								_existingDistributions.DistributionList &&
								_existingDistributions.DistributionList.Quantity > 0
							) {
								_existingDistributions.DistributionList.Items.forEach(function (distribution) {
									if (found) return; // TODO: exit foreach
									if (distribution.Comment === distributionId) {
										found = distribution;
									}
								});
							}

							if (found) {

								if (found.Status !== "Deployed") {
									console.log("Distribution not yet deployed.");
									return repeat(callback);
								}

								console.log("Distribution Domain:", found.DomainName);


								function invalidateDistribution (callback) {
									if (uploadedPaths.length === 0) {
										return callback(null);
									}

									uploadedPaths = uploadedPaths.map(function (path) {
							      	  return "/" + path;
							        });

									console.log("Invalidating paths:", uploadedPaths);

									return cloudfront.createInvalidation({
									  DistributionId: found.Id,
									  InvalidationBatch: {
									    CallerReference: "invlidate-"+Date.now(),
									    Paths: {
									      Quantity: uploadedPaths.length,
									      Items: uploadedPaths
									    }
									  }
									}, function (err, data) {
										if (err) return callback(err);
										return callback();
									});									
								}

								return invalidateDistribution(callback);
							}

/*
							function ensureOriginAccessIdentity (callback) {
								return cloudfront.createCloudFrontOriginAccessIdentity({
								  // TODO: Generate a better hash
								  CloudFrontOriginAccessIdentityConfig: {
								    CallerReference: bucketName,
								    Comment: bucketName
								  }
								}, function (err, data) {
									if (err) return callback(err);

									return callback(null, data.CloudFrontOriginAccessIdentity);
								});
							}

							return ensureOriginAccessIdentity(function (err, OriginAccessIdentity) {
								if (err) return callback(err);

console.log("OriginAccessIdentity", OriginAccessIdentity);
// @see http://docs.aws.amazon.com/AWSJavaSDK/latest/javadoc/com/amazonaws/services/cloudfront/model/S3OriginConfig.html
// Access identity not needed if we want to allow access to S3 and CloudFront.
*/

								return cloudfront.createDistribution(config, function(err, data) {
									if (err) return callback(err);

									return repeat(callback);
								});
//							});
						});
					}

					var fromPath = null;

					if (
						packageDescriptor.layout &&
						packageDescriptor.layout.directories &&
						packageDescriptor.layout.directories.bundles
					) {
						fromPath = API.PATH.join(sourcePath, packageDescriptor.layout.directories.bundles);
					} else {
						fromPath = API.PATH.join(sourcePath, "bundles");
					}

					return copyFiles(fromPath, pubPath, function (err) {
						if (err) return callback(err)

						return writeLoader(function (err) {
							if (err) return callback(err);

							return copyCustomTemplates(function (err) {
								if (err) return callback(err);

								return writeProgramDescriptor(function (err) {
									if (err) return callback(err);

									return ensureUploaded(function (err, s3BucketHost, uploadedPaths) {
										if (err) return callback(err);

										return ensureDistribution(s3BucketHost, uploadedPaths, callback);
									});
								});
							});
						});
					});
					
				} catch (err) {
					return callback(err);
				}
			});
		}

		return waitfor();
	});
});

