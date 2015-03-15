

const AWS = require("aws-sdk");
const S3 = require("s3");
const URL = require("url");


require("to.pinf.lib/lib/run").for(module, function (API, callback) {

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

	return API.getPrograms(function (err, programs) {
		if (err) return callback(err);

		var waitfor = API.WAITFOR.serial(callback);
		
		for (var programDescriptorPath in programs) {
			waitfor(programDescriptorPath, function (programDescriptorPath, done) {

				try {

					programDescriptor = programs[programDescriptorPath];

					API.ASSERT.equal(typeof programDescriptor.combined.name, "string", "name' must be set in '" + programDescriptorPath + "'");

					var programName = programDescriptor.combined.name.toLowerCase();

					console.log("Run program (" + programName + "):", programDescriptorPath);

					var url = "http://" + URL.parse(S3.getPublicUrlHttp(bucketName, "")).hostname;

					// TODO: Open browser window.
					console.log("Run:", "open " + url);

					return done();

				} catch (err) {
					return done(err);
				}
			});
		}

		return waitfor();
	});
});
