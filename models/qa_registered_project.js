module.exports = (sequelize, DataTypes) => {
  const QaRegisteredProject = sequelize.define(
    "qa_registered_project",
    {
      qa_project_id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
      },
      project_name: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      project_details: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      rfb_details: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      ca_no: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      bbu_no: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      po_no: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      loa_no: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      contractor_name: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      contractor_address: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      mdcc_no: {
        type: DataTypes.STRING,
        allowNull: true,
      },
    },
    {
      timestamps: true,
      freezeTableName: true,
    }
  );
  return QaRegisteredProject;
};